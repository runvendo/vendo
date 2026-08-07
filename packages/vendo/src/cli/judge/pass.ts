import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { fieldSemanticSchema, gradedRiskLabelSchema } from "@vendoai/core";
import {
  VENDO_JUDGMENTS_FORMAT,
  applyJudgment,
  bindingIdentity,
  judgmentsFileSchema,
  overridesFileSchema,
  pruneJudgments,
  splitProposal,
  toolsFileSchema,
  type ExtractedTool,
  type JudgmentFields,
  type JudgmentProposal,
  type JudgmentsFile,
  type PendingLoosening,
  type ToolJudgment,
} from "@vendoai/actions";
import type { ExtractionHarness } from "../extract/harness.js";
import { parseJudgeArtifact } from "./parse.js";
import { readOptional, type Output } from "../shared.js";
import { resolveJudgmentEngine, type ResolveEngineOptions } from "./engine.js";
import { composeJudgeInstructions, composeSkepticInstructions, type SkepticSubject } from "./prompts.js";
import { reviewLoosenings, sanitize, type LooseningReviewItem } from "./review.js";

/**
 * The judgment channel: read the deterministic catalog, ask a model to grade it,
 * ask a SECOND model to tear the first one's answer apart, and write only what
 * survives into `.vendo/judgments.json`.
 *
 * The shape exists because of one measured failure mode. A single model pass
 * that is allowed to grade capability will confidently justify a grade the code
 * does not support — in either direction. An over-tight grade silently breaks a
 * working product; a loose one hands out capability. So:
 *
 * - the JUDGE proposes, and every proposal costs a VERBATIM quote from the
 *   handler. No quote, no proposal — rejected at parse, counted out loud;
 * - the SKEPTIC is a second, independent run (fresh conversation, same engine)
 *   whose only job is to check each field against the real source, including
 *   whether the quote exists at all. It rejects hardenings as readily as
 *   loosenings;
 * - anything the skeptic never looked at gets ONE re-ask and is then REJECTED.
 *   Unexamined must never mean applied, and the narrative says how many;
 * - what survives is routed by the deterministic direction rule in
 *   `@vendoai/actions`: hardenings and prose apply themselves, loosenings wait
 *   for a human.
 *
 * Every model-originated string and every evidence snippet is untrusted repo
 * content and is sanitized before it reaches a terminal.
 */

/** One judge call reads this many tools. Big enough that a normal catalog is one
 *  or two calls, small enough that the model actually opens each handler instead
 *  of skimming a wall of names. */
export const JUDGE_BATCH_LIMIT = 20;

/** The AI-writable surface, wire-shaped, with `evidence` REQUIRED. Unknown keys
 *  (bindings, schemas, ids…) are stripped by zod's default object behavior — the
 *  deterministic skeleton is not expressible here. */
const judgeProposalSchema = z.object({
  name: z.string().min(1),
  evidence: z.string().min(1).max(500),
  reason: z.string().max(300).optional(),
  description: z.string().min(1).max(500).optional(),
  title: z.string().min(1).max(60).optional(),
  // The judge GRADES: "ungraded" is the absence of a grade, never a proposal.
  risk: gradedRiskLabelSchema.optional(),
  confirmEach: z.boolean().optional(),
  disabled: z.boolean().optional(),
  audience: z.enum(["end-user", "operator", "internal"]).optional(),
  semantics: z.record(fieldSemanticSchema).optional(),
});

/** Advisory bounds. These are CLAMPED, never enforced by rejection — see
 *  `judgeResultSchema` for why that distinction is load-bearing. */
const ADVISORY_LIMIT = 300;
const NARRATIVE_LIMIT = 4000;

/**
 * The envelope validates ONLY what routing needs, and validates it loosely:
 * `tools` items are `unknown` so one bad proposal cannot fail a batch of twenty,
 * and EVERY advisory field is `unknown` so no advisory can fail the batch at all.
 *
 * That second half is the invariant, and it was learned the hard way.
 * `missedSurfaces` and `narrative` used to carry `.max()` bounds HERE, inside the
 * schema `parseArtifact` validates — so a single advisory string 37 characters
 * over the limit threw during parse and took every evidence-backed proposal in
 * the batch down with it. Observed on openstatus (9 judgments discarded because
 * two advisory strings were 37 and 11 chars long) and on demo-bank, which lost
 * host_transferMoney and host_createOrder on 3 runs of 3.
 *
 * Advisories are leads for a human. A lead must never outrank a judgment, so
 * proposals and advisories do not share one all-or-nothing parse: bounds are
 * applied by clamping AFTER the parse (`normalizeAdvisories`), and every clamp is
 * counted and reported rather than silently absorbed.
 */
const judgeResultSchema = z.object({
  // REQUIRED, not `.default([])`. A default here is what lets a bare inner tool
  // object pose as a valid empty envelope, so any span-scanning parse would
  // return a cheerful "0 tools judged" instead of failing — a silent empty
  // success that gets SCORED, where a loud failure would have been retried.
  // Requiring the key makes that impossible. A genuinely empty batch still says
  // so explicitly with `"tools": []`, which the prompt asks for.
  tools: z.array(z.unknown()),
  missedSurfaces: z.unknown().optional(),
  narrative: z.unknown().optional(),
});

/** Bounded PROSE on one proposal, each with the limit Lane A's
 *  `judgmentFieldsSchema` accepts downstream. Clamped before validation for the
 *  same reason as above: a sentence that ran long is a formatting slip, not a
 *  reason to throw away the handler evidence attached to it. Capability fields
 *  (the enums and booleans) are deliberately absent — an invented `risk` value is
 *  a real error and must still be rejected. */
const PROSE_LIMITS: ReadonlyArray<readonly [string, number]> = [
  ["description", 500],
  ["title", 60],
  ["reason", ADVISORY_LIMIT],
  // A quote that ran long is still evidence. Unclamped, the schema rejects it
  // with an issue on the `evidence` path, and every issue on that path is
  // counted as evidence-LESS — so the most thorough answer the model can give
  // is reported to the operator as "no evidence" and the grade is discarded.
  ["evidence", 500],
];

/** Cut to `limit`, marking the cut so a reader can tell clamped text from text
 *  the model chose to write short. */
const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

interface Advisories {
  surfaces: string[];
  narrative: string;
  /** Advisory strings truncated or dropped. Reported, never silent. */
  clamped: number;
}

/** Pull the advisories out of a parsed batch, clamping instead of rejecting.
 *  Nothing here can throw, which is the whole point. */
function normalizeAdvisories(artifact: { missedSurfaces?: unknown; narrative?: unknown }): Advisories {
  let clamped = 0;
  const surfaces: string[] = [];
  const raw = artifact.missedSurfaces;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      // A non-string "lead" names no surface — drop it, but say that it existed.
      if (typeof entry !== "string" || entry.trim() === "") {
        clamped += 1;
        continue;
      }
      if (entry.length > ADVISORY_LIMIT) clamped += 1;
      surfaces.push(truncate(entry, ADVISORY_LIMIT));
    }
  } else if (raw !== undefined) {
    clamped += 1;
  }

  let narrative = "";
  if (typeof artifact.narrative === "string") {
    if (artifact.narrative.length > NARRATIVE_LIMIT) clamped += 1;
    narrative = truncate(artifact.narrative, NARRATIVE_LIMIT).trim();
  } else if (artifact.narrative !== undefined) {
    clamped += 1;
  }
  return { surfaces, narrative, clamped };
}

/** Clamp a raw proposal's bounded prose before it reaches the strict schema. */
function clampProse(raw: unknown): { value: unknown; clamped: number } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { value: raw, clamped: 0 };
  const next: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  let clamped = 0;
  for (const [field, limit] of PROSE_LIMITS) {
    const value = next[field];
    if (typeof value === "string" && value.length > limit) {
      next[field] = truncate(value, limit);
      clamped += 1;
    }
  }
  return { value: next, clamped };
}

const skepticVerdictSchema = z.object({
  name: z.string().min(1),
  field: z.string().min(1),
  verdict: z.enum(["uphold", "reject"]),
  reason: z.string().max(300).optional(),
});

/** Same per-item leniency as the judge envelope, and here it fails CLOSED: a
 *  verdict that does not parse leaves its (tool, field) unexamined, which routes
 *  into the re-ask and then into rejection. */
const skepticResultSchema = z.object({
  // Required for the same reason as `tools` above. An unparseable skeptic reply
  // already fails closed (everything unexamined → re-ask → rejected), but a
  // reply that merely LOOKS empty must not be mistaken for a real one.
  verdicts: z.array(z.unknown()),
});

/**
 * Phrases in which a proposal's own reason asserts the handler mutates nothing.
 *
 * Deliberately NARROW. This is a backstop for a model contradicting itself, and
 * a false positive would silently discard a real grade — so it fires only on an
 * explicit no-state-change claim, never on an inference. The primary fix is the
 * risk rule in prompts.ts, which now states the actual test (mutation of stored
 * state) instead of the "provably only reads" phrasing the model read as
 * "provably inert" and hedged around.
 */
const NO_MUTATION_CLAIMS: readonly RegExp[] = [
  /\bno\s+(?:data|state|db|database|persistent)\s+(?:change|changes|mutation|mutations|write|writes)\b/i,
  /\bno\s+(?:mutations?|writes)\b/i,
  /\b(?:does|do)\s+not\s+(?:modify|mutate|write|persist|change)\b/i,
  /\b(?:doesn't|don't|never)\s+(?:modify|mutate|write|persist|change)\b/i,
  /\bread[-\s]only\b/i,
  /\bonly\s+reads\b/i,
  /\bno\s+side[-\s]effects?\b/i,
];

/** "…is not read-only" is the OPPOSITE claim, and must not read as one. */
const NEGATED_NO_MUTATION = /\b(?:not|isn't|aren't)\s+(?:a\s+|an\s+)?read[-\s]only\b/i;

function assertsNoMutation(reason: string): boolean {
  if (NEGATED_NO_MUTATION.test(reason)) return false;
  return NO_MUTATION_CLAIMS.some((pattern) => pattern.test(reason));
}

/** Every field a judgment may carry, in the order the narrative reports them. */
const JUDGMENT_FIELDS = ["description", "title", "risk", "confirmEach", "disabled", "audience", "semantics"] as const;

export interface JudgmentPassOptions {
  root: string;
  /** The `.vendo` directory (sync's `out`). */
  out: string;
  /** full: judge the whole catalog. incremental: only what moved. */
  mode: "full" | "incremental";
  /** review: ask about loosenings now. queue: park them as `pending`. */
  loosenings: "review" | "queue";
  env: Record<string, string | undefined>;
  output: Output;
  /** Adapter rule: an explicitly passed harness always wins over the ladder. */
  harness?: ExtractionHarness;
  /** `--engine` family pin. An unavailable pin never falls back. */
  engine?: string;
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** Ladder seams. */
  harnesses?: ExtractionHarness[];
  resolveCredential?: ResolveEngineOptions["resolveCredential"];
  appName?: string;
  onProgress?: (line: string) => void;
}

export interface JudgmentPassCounts {
  /** Tools whose judgment entry this pass wrote or updated. */
  judged: number;
  /** (tool, field) hardenings and prose edits applied. */
  hardened: number;
  /** Loosenings left waiting as `pending`. */
  queued: number;
  /** Loosenings a human accepted this run. */
  approved: number;
  rejectedBySkeptic: number;
  unexaminedRejected: number;
  /** Proposals thrown out at parse for carrying no evidence. */
  evidenceless: number;
  /** Advisory and prose strings truncated or dropped so they could not discard a
   *  judgment. Never fatal — surfaced so a clamped lead is visible. */
  advisoriesClamped: number;
  /** Risk grades dropped for contradicting their own stated reason. */
  inconsistentRisk: number;
}

export type JudgmentPassResult =
  | ({ status: "judged" } & JudgmentPassCounts)
  | { status: "structural-only"; unjudged: number }
  | { status: "up-to-date" }
  | { status: "skipped" };

/** A candidate and everything the pass needs to reason about it: the raw
 *  skeleton entry, the standing judgment that still describes it, and the
 *  EFFECTIVE state the direction rule must be computed against. */
interface Candidate {
  tool: ExtractedTool;
  effective: ExtractedTool;
  /** The stored judgment, only when its binding still matches. A rebound
   *  entry is inert and gets replaced, so it is not built upon. */
  existing: ToolJudgment | undefined;
}

interface Proposal {
  candidate: Candidate;
  fields: JudgmentFields;
  evidence: string;
  reason?: string;
}

const verdictKey = (name: string, field: string): string => `${name}\u0000${field}`;

/**
 * Join labels for the narrative, SANITIZING every element.
 *
 * This is the one chokepoint every name/field list print flows through, so the
 * rule — nothing the model authored reaches a terminal carrying control bytes —
 * holds here by construction instead of by remembering it at each of a dozen
 * call sites. Remembering is what failed: the evidence-less and malformed
 * name paths printed raw model output while their sibling three lines away
 * sanitized correctly (Codex adversarial finding 2). A tool "name" is
 * model-authored text like any other, and a hostile repo can steer the model
 * into emitting one full of ANSI/OSC escapes that rewrite the narrative the
 * developer is reading to make a trust decision.
 */
const listed = (names: string[], limit = 10): string => {
  const safe = names.map(sanitize);
  return safe.length <= limit
    ? safe.join(", ")
    : `${safe.slice(0, limit).join(", ")} +${safe.length - limit} more`;
};

const chunked = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size));
  return chunks;
};

/** Write only when the bytes changed, so an unchanged pass leaves mtimes alone
 *  (writeIfChanged-style, matching how sync writes its own artifacts). */
async function writeIfChanged(file: string, bytes: string): Promise<void> {
  try {
    if (await readFile(file, "utf8") === bytes) return;
  } catch {
    // A missing artifact is created below.
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes, "utf8");
}

/** The tool's effective value for one loosenable grade — the "from" side of the
 *  review diff. An ungraded audience behaves as end-user; the two booleans
 *  default false. */
function effectiveValue(tool: ExtractedTool, field: PendingLoosening["field"]): string | boolean {
  if (field === "risk") return tool.risk;
  if (field === "audience") return tool.audience ?? "end-user";
  return tool[field] ?? false;
}

/** Move an approved loosening into the applied fields. Returns false for a value
 *  that does not type-check for its field — a corrupted `pending` entry is
 *  dropped rather than spread onto a tool. */
function promote(fields: JudgmentFields, pending: PendingLoosening): boolean {
  const { field, value } = pending;
  if (field === "risk" && (value === "read" || value === "write" || value === "destructive")) {
    fields.risk = value;
    return true;
  }
  if (field === "audience" && (value === "end-user" || value === "operator" || value === "internal")) {
    fields.audience = value;
    return true;
  }
  if ((field === "confirmEach" || field === "disabled") && typeof value === "boolean") {
    fields[field] = value;
    return true;
  }
  return false;
}

async function readJudgmentsFile(path: string): Promise<JudgmentsFile | null> {
  const raw = await readOptional(path);
  if (raw === null) return null;
  // LOUD on purpose: this file can carry DISABLES, so silently ignoring a
  // malformed one would silently LOOSEN the catalog.
  return judgmentsFileSchema.parse(JSON.parse(raw) as unknown);
}

export async function runJudgmentPass(options: JudgmentPassOptions): Promise<JudgmentPassResult> {
  const { output } = options;
  const toolsRaw = await readOptional(join(options.out, "tools.json"));
  if (toolsRaw === null) return { status: "skipped" };
  let tools: ExtractedTool[];
  try {
    tools = toolsFileSchema.parse(JSON.parse(toolsRaw) as unknown).tools;
  } catch {
    // An unparseable tools.json means the structural sync already failed loudly.
    return { status: "skipped" };
  }

  const judgmentsPath = join(options.out, "judgments.json");
  const storedFile = await readJudgmentsFile(judgmentsPath);
  const stored: Record<string, ToolJudgment> = storedFile?.tools ?? {};

  // ------------------------------------------------------------------
  // Candidates. The whole set in full mode; in incremental mode a tool is a
  // candidate when it has never been judged, when its judgment describes a
  // handler that MOVED (binding mismatch — the entry is inert), or when its
  // source hash drifted out from under a standing judgment.
  // ------------------------------------------------------------------
  const byName = new Map<string, Candidate>();
  for (const tool of tools) {
    const entry = stored[tool.name];
    const valid = entry !== undefined && entry.binding === bindingIdentity(tool.binding) ? entry : undefined;
    byName.set(tool.name, { tool, effective: applyJudgment(tool, valid), existing: valid });
  }
  const candidates = [...byName.values()]
    .filter((candidate) => options.mode === "full"
      || candidate.existing === undefined
      || candidate.existing.srcHash !== candidate.tool.srcHash)
    .sort((left, right) => bindingIdentity(left.tool.binding).localeCompare(bindingIdentity(right.tool.binding)));

  // The up-to-date check is purely LOCAL and runs BEFORE engine resolution: a
  // fully judged, unchanged catalog says so whether or not a model key is
  // around, and a keyed run never probes an engine just to find no work.
  if (candidates.length === 0) {
    output.log("judgment: up to date");
    return { status: "up-to-date" };
  }

  // ------------------------------------------------------------------
  // Engine ladder.
  // ------------------------------------------------------------------
  let harness = options.harness;
  let credential = "explicit engine";
  if (harness === undefined) {
    const resolved = await resolveJudgmentEngine({
      root: options.root,
      env: options.env,
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      ...(options.harnesses === undefined ? {} : { harnesses: options.harnesses }),
      ...(options.resolveCredential === undefined ? {} : { resolveCredential: options.resolveCredential }),
    });
    if (resolved.engine === null) {
      // Keyless is not an error: the structural catalog stands on its own and
      // the unjudged tools keep their fail-closed extraction grades.
      // The reason embeds the `--engine` flag and a harness credential label —
      // neither is model-authored, but sanitizing keeps ONE rule in this file
      // instead of a per-line provenance argument.
      output.log(
        `judgment: structural-only (${sanitize(resolved.reason ?? "no engine")}) — ${candidates.length} tools unjudged`,
      );
      return { status: "structural-only", unjudged: candidates.length };
    }
    harness = resolved.engine.harness;
    credential = resolved.engine.credential;
  }

  const overridesRaw = await readOptional(join(options.out, "overrides.json"));
  let overrideNames: string[] = [];
  if (overridesRaw !== null) {
    try {
      overrideNames = Object.keys(overridesFileSchema.parse(JSON.parse(overridesRaw) as unknown).tools ?? {});
    } catch {
      // A malformed overrides file already failed the structural sync loudly;
      // here it is only read-only prompt context.
    }
  }

  let appName = options.appName;
  if (appName === undefined) {
    try {
      appName = (JSON.parse((await readOptional(join(options.root, "package.json"))) ?? "{}") as { name?: string }).name ?? "app";
    } catch {
      appName = "app";
    }
  }

  const artifactDir = join(options.out, "data", "judge");
  await rm(artifactDir, { recursive: true, force: true });
  const notes: string[] = [];
  /** Stages whose output needed a syntax repair — warned about, never hidden. */
  const repairedStages: string[] = [];
  const writeArtifact = async (stage: string, body: unknown): Promise<void> => {
    await writeIfChanged(join(artifactDir, `${stage}.json`), `${JSON.stringify(body, null, 2)}\n`);
  };
  const failure = (error: unknown): string => error instanceof Error ? error.message : "unknown error";

  /** One harness call plus its artifact. A throw is recorded and rethrown so the
   *  caller decides whether that stage is fatal. */
  async function runStage<Schema extends z.ZodTypeAny>(
    stage: string,
    instructions: string,
    schema: Schema,
  ): Promise<z.infer<Schema>> {
    let text: string | null = null;
    try {
      text = await harness!.run({
        root: options.root,
        env: options.env,
        instructions,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      });
      // Tolerant of a syntax slip, loud about anything it cannot rescue — see
      // judge/parse.ts for the two preserved failures that motivate it.
      const parsed = parseJudgeArtifact(text, schema);
      if (parsed.repaired) {
        repairedStages.push(stage);
        // The RAW text rides along in the artifact so the slip stays diagnosable
        // after a repair, not just after a failure.
        await writeArtifact(stage, { stage, repaired: true, artifact: parsed.artifact, raw: text });
      } else {
        await writeArtifact(stage, parsed.artifact);
      }
      return parsed.artifact;
    } catch (error) {
      await writeArtifact(stage, { stage, error: failure(error), ...(text === null ? {} : { raw: text }) });
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // JUDGE.
  // ------------------------------------------------------------------
  const chunks = chunked(candidates, JUDGE_BATCH_LIMIT);
  const proposals = new Map<string, Proposal>();
  const evidenceless: string[] = [];
  const malformed: string[] = [];
  const unknownTools: string[] = [];
  const inconsistentRisk: string[] = [];
  const missedSurfaces: string[] = [];
  const narratives: string[] = [];
  let advisoriesClamped = 0;
  let judgeChunksParsed = 0;

  for (const [index, chunk] of chunks.entries()) {
    options.onProgress?.(chunks.length > 1
      ? `judging ${chunk.length} tools (batch ${index + 1}/${chunks.length})`
      : `judging ${chunk.length} tools`);
    let artifact: z.infer<typeof judgeResultSchema>;
    try {
      artifact = await runStage(
        `judge-${index + 1}`,
        composeJudgeInstructions({
          appName,
          tools: chunk.map((candidate) => candidate.effective),
          overrideNames,
          chunk: { index, total: chunks.length },
          last: index === chunks.length - 1,
        }),
        judgeResultSchema,
      );
    } catch (error) {
      notes.push(`judge batch ${index + 1}/${chunks.length} unusable (${failure(error)}) — its tools stay unjudged`);
      continue;
    }
    judgeChunksParsed += 1;
    const advisories = normalizeAdvisories(artifact);
    advisoriesClamped += advisories.clamped;
    if (advisories.narrative !== "") narratives.push(advisories.narrative);
    missedSurfaces.push(...advisories.surfaces);

    for (const raw of artifact.tools) {
      const prose = clampProse(raw);
      advisoriesClamped += prose.clamped;
      const parsed = judgeProposalSchema.safeParse(prose.value);
      if (!parsed.success) {
        // Sanitized at INGEST, not just at the print site, so the value is safe
        // everywhere it travels — this name never matched a real tool, so it is
        // pure model text with no schema behind it.
        const name = typeof (raw as { name?: unknown } | null)?.name === "string"
          ? sanitize((raw as { name: string }).name)
          : "(unnamed)";
        // Evidence is the one requirement worth counting separately: it is the
        // difference between a finding and an opinion.
        if (parsed.error.issues.some((issue) => issue.path[0] === "evidence")) evidenceless.push(name);
        else malformed.push(name);
        continue;
      }
      const candidate = byName.get(parsed.data.name);
      if (candidate === undefined) {
        // Parsed, but names no tool in the catalog — so it is model text that
        // never met a schema constraint either. Same ingest-time sanitize.
        unknownTools.push(sanitize(parsed.data.name));
        continue;
      }
      const fields: JudgmentFields = {};
      for (const key of JUDGMENT_FIELDS) {
        const value = parsed.data[key];
        if (value !== undefined) Object.assign(fields, { [key]: value });
      }
      // Self-consistency backstop. The model hedges upward: it emits `write`
      // while its own reason says the handler changes no stored state (cache
      // revalidation, a GET dispatching query procedures). Such a grade is
      // DROPPED, not corrected in either direction — applying it would auto-apply
      // a hardening the reason itself denies, and rewriting it to `read` would
      // apply a loosening no human approved. Dropping leaves the tool's standing
      // grade untouched, which is the only move that loosens nothing.
      if (
        (fields.risk === "write" || fields.risk === "destructive")
        && parsed.data.reason !== undefined
        && assertsNoMutation(parsed.data.reason)
      ) {
        delete fields.risk;
        inconsistentRisk.push(parsed.data.name);
      }
      proposals.set(parsed.data.name, {
        candidate,
        fields,
        evidence: parsed.data.evidence,
        ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
      });
    }
  }

  if (judgeChunksParsed === 0) {
    output.error(
      `warning: judgment output unparseable — skipped, the structural catalog stands (${sanitize(notes[0] ?? "no usable batch")})`,
    );
    return { status: "skipped" };
  }

  // ------------------------------------------------------------------
  // SKEPTIC — a second, independent run per chunk. `harness.run` is stateless,
  // so each call is a fresh conversation on the same engine.
  // ------------------------------------------------------------------
  const subjects: SkepticSubject[] = [];
  for (const proposal of proposals.values()) {
    const moves = Object.entries(proposal.fields).map(([field, to]) => ({
      field,
      from: effectiveFrom(proposal.candidate.effective, field),
      to,
    }));
    // A proposal with no fields is a bare CONFIRMATION ("I read this, nothing to
    // change"). There is nothing to uphold, so it does not cost a skeptic call.
    if (moves.length === 0) continue;
    subjects.push({
      tool: proposal.candidate.effective,
      moves,
      evidence: proposal.evidence,
      ...(proposal.reason === undefined ? {} : { reason: proposal.reason }),
    });
  }

  const verdicts = new Map<string, { verdict: "uphold" | "reject"; reason?: string }>();
  const collectVerdicts = (artifact: z.infer<typeof skepticResultSchema>): void => {
    for (const raw of artifact.verdicts) {
      const parsed = skepticVerdictSchema.safeParse(raw);
      if (!parsed.success) continue; // unparsed → unexamined → fails closed below
      verdicts.set(verdictKey(parsed.data.name, parsed.data.field), {
        verdict: parsed.data.verdict,
        ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
      });
    }
  };

  for (const [index, chunk] of chunked(subjects, JUDGE_BATCH_LIMIT).entries()) {
    options.onProgress?.(`checking ${chunk.length} proposals against the source`);
    try {
      collectVerdicts(await runStage(
        `skeptic-${index + 1}`,
        composeSkepticInstructions({ appName, subjects: chunk }),
        skepticResultSchema,
      ));
    } catch (error) {
      // Every pair in this chunk is now unexamined — the re-ask picks them up,
      // and anything still unanswered is rejected.
      notes.push(`skeptic batch ${index + 1} unusable (${failure(error)}) — its proposals go to the re-ask`);
    }
  }

  // ONE re-ask covering everything the skeptic did not examine. Never a loop:
  // an engine that ignored the question twice is not going to answer it.
  const unexaminedSubjects: SkepticSubject[] = [];
  for (const subject of subjects) {
    const moves = subject.moves.filter((move) => !verdicts.has(verdictKey(subject.tool.name, move.field)));
    if (moves.length > 0) unexaminedSubjects.push({ ...subject, moves });
  }
  if (unexaminedSubjects.length > 0) {
    options.onProgress?.("re-asking the skeptic about unexamined fields");
    try {
      collectVerdicts(await runStage(
        "skeptic-reask",
        composeSkepticInstructions({ appName, subjects: unexaminedSubjects, reask: true }),
        skepticResultSchema,
      ));
    } catch (error) {
      notes.push(`skeptic re-ask unusable (${failure(error)}) — the unexamined fields are rejected`);
    }
  }

  // ------------------------------------------------------------------
  // Routing.
  // ------------------------------------------------------------------
  const next: Record<string, ToolJudgment> = { ...stored };
  const rejectedBySkeptic: string[] = [];
  const unexaminedRejected: string[] = [];
  const hardenedFields: string[] = [];
  const discredited: string[] = [];
  const judgedNames: string[] = [];

  for (const proposal of proposals.values()) {
    const { candidate } = proposal;
    const name = candidate.tool.name;
    const upheld: JudgmentFields = {};
    for (const [field, value] of Object.entries(proposal.fields)) {
      const verdict = verdicts.get(verdictKey(name, field));
      if (verdict === undefined) {
        unexaminedRejected.push(`${name}.${field}`);
        continue;
      }
      if (verdict.verdict === "reject") {
        rejectedBySkeptic.push(
          `${name}.${field}${verdict.reason === undefined ? "" : ` — ${sanitize(verdict.reason)}`}`,
        );
        continue;
      }
      Object.assign(upheld, { [field]: value });
    }

    // Every field discredited means the proposal — and the quote it rests on —
    // did not survive review. Writing an entry from it would record evidence the
    // skeptic just called fabricated, so nothing is written and the tool stays a
    // candidate for the next run.
    const proposedCount = Object.keys(proposal.fields).length;
    if (proposedCount > 0 && Object.keys(upheld).length === 0) {
      discredited.push(name);
      continue;
    }

    const wire: JudgmentProposal = {
      ...upheld,
      evidence: proposal.evidence,
      ...(proposal.reason === undefined ? {} : { reason: proposal.reason }),
    };
    const { hardenings, loosenings } = splitProposal(candidate.effective, wire);

    const base = candidate.existing;
    const fields: JudgmentFields = { ...(base?.fields ?? {}), ...hardenings };
    // Semantics merge PER KEY: a judgment corrects individual response fields,
    // it never wipes what a previous pass established.
    if (hardenings.semantics !== undefined) {
      fields.semantics = { ...(base?.fields.semantics ?? {}), ...hardenings.semantics };
    }
    for (const field of Object.keys(hardenings)) hardenedFields.push(`${name}.${field}`);

    next[name] = {
      binding: bindingIdentity(candidate.tool.binding),
      ...(candidate.tool.srcHash === undefined ? {} : { srcHash: candidate.tool.srcHash }),
      fields,
      evidence: proposal.evidence,
      ...(((base?.pending ?? []).length + loosenings.length) > 0
        ? { pending: [...(base?.pending ?? []), ...loosenings] }
        : {}),
    };
    judgedNames.push(name);
  }

  // Drop entries that no longer describe anything BEFORE the review, so a human
  // is never asked about a loosening on a tool that vanished.
  const pruned = pruneJudgments({ format: VENDO_JUDGMENTS_FORMAT, tools: next }, tools);

  // ------------------------------------------------------------------
  // Loosenings: one aggregated decision, or the queue.
  // ------------------------------------------------------------------
  let approved = 0;
  let queued = 0;
  let declined = 0;
  if (options.loosenings === "review") {
    const items: LooseningReviewItem[] = [];
    for (const [name, entry] of Object.entries(pruned.tools)) {
      const tool = byName.get(name)?.tool;
      if (tool === undefined || (entry.pending ?? []).length === 0) continue;
      // The "from" side is the state AFTER this run's hardenings landed —
      // otherwise the diff shows a value the loosening no longer moves from.
      const { pending: _queued, ...applied } = entry;
      const effective = applyJudgment(tool, applied);
      for (const pending of entry.pending ?? []) {
        items.push({
          name,
          field: pending.field,
          from: effectiveValue(effective, pending.field),
          to: pending.value,
          evidence: pending.evidence,
          ...(pending.reason === undefined ? {} : { reason: pending.reason }),
        });
      }
    }
    const verdict = items.length === 0 ? "approved" : await reviewLoosenings(items, {
      note: (line) => output.log(line),
      confirm: options.confirm ?? (async () => false),
    });
    for (const [name, entry] of Object.entries(pruned.tools)) {
      const pending = entry.pending ?? [];
      if (pending.length === 0) continue;
      const fields: JudgmentFields = { ...entry.fields };
      if (verdict === "approved") {
        for (const item of pending) if (promote(fields, item)) approved += 1;
      } else {
        declined += pending.length;
      }
      // Either way the queue is emptied: an approved loosening moved into
      // `fields`, and a declined one is DROPPED rather than silently re-queued
      // so the same question is not asked forever.
      const { pending: _dropped, ...rest } = entry;
      pruned.tools[name] = { ...rest, fields };
    }
  } else {
    for (const entry of Object.values(pruned.tools)) queued += (entry.pending ?? []).length;
  }

  // ------------------------------------------------------------------
  // Write. Stable key order, no-churn bytes, and validated against the strict
  // schema — a malformed write is a bug here and must never land on disk.
  // ------------------------------------------------------------------
  const sortedTools: Record<string, ToolJudgment> = {};
  for (const name of Object.keys(pruned.tools).sort()) sortedTools[name] = pruned.tools[name]!;
  const file = judgmentsFileSchema.parse({ format: VENDO_JUDGMENTS_FORMAT, tools: sortedTools });
  // Don't create an empty file where none existed: a pass that found nothing to
  // record leaves the directory as it was.
  if (storedFile !== null || Object.keys(sortedTools).length > 0) {
    await writeIfChanged(judgmentsPath, `${JSON.stringify(file, null, 2)}\n`);
  }

  // ------------------------------------------------------------------
  // Narrative.
  // ------------------------------------------------------------------
  output.log(`judgment (${sanitize(credential)}): ${judgedNames.length} tools judged`);
  if (hardenedFields.length > 0) output.log(`  hardened (${hardenedFields.length}): ${listed(hardenedFields)}`);
  if (approved > 0) output.log(`  loosenings approved (${approved})`);
  if (declined > 0) output.log(`  loosenings declined and dropped (${declined})`);
  if (queued > 0) {
    output.log(`  ${queued} loosenings queued — review with \`vendo sync --review\``);
  }
  if (rejectedBySkeptic.length > 0) {
    output.log(`  rejected by the skeptic (${rejectedBySkeptic.length}): ${listed(rejectedBySkeptic, 6)}`);
  }
  if (unexaminedRejected.length > 0) {
    output.log(
      `  unexamined after one re-ask, rejected (${unexaminedRejected.length}): ${listed(unexaminedRejected, 6)}`,
    );
  }
  if (evidenceless.length > 0) {
    output.log(`  no evidence → rejected (${evidenceless.length}): ${listed(evidenceless)}`);
  }
  if (malformed.length > 0) output.log(`  malformed proposals ignored (${malformed.length}): ${listed(malformed)}`);
  if (inconsistentRisk.length > 0) {
    output.log(
      `  risk grade contradicted its own reason, dropped (${inconsistentRisk.length}):`
      + ` ${listed(inconsistentRisk)}`,
    );
  }
  if (discredited.length > 0) {
    output.log(`  wholly rejected, left unjudged (${discredited.length}): ${listed(discredited)}`);
  }
  if (unknownTools.length > 0) {
    output.log(`  proposals for unknown tools ignored (${unknownTools.length}): ${listed(unknownTools)}`);
  }
  if (advisoriesClamped > 0) {
    output.error(
      `warning: ${advisoriesClamped} advisory string${advisoriesClamped === 1 ? "" : "s"} clamped`
      + " (over-long or unusable) — tool judgments were unaffected",
    );
  }
  if (repairedStages.length > 0) {
    output.error(
      `warning: ${repairedStages.length} model reply had malformed JSON and was repaired`
      + ` (${repairedStages.join(", ")}) — grades recovered; raw output kept in .vendo/data/judge/`,
    );
  }
  for (const note of notes) output.error(`warning: ${sanitize(note)}`);
  for (const narrative of narratives) {
    for (const line of narrative.split("\n")) output.log(`  ${sanitize(line)}`);
  }
  // Coverage leads are WARNINGS, never tools: naming a surface is a lead, and
  // adding a tool is the deterministic scanner's job.
  for (const missed of missedSurfaces) {
    output.error(`warning: missed surface (not extracted yet): ${sanitize(missed)}`);
  }

  return {
    status: "judged",
    judged: judgedNames.length,
    hardened: hardenedFields.length,
    queued,
    approved,
    rejectedBySkeptic: rejectedBySkeptic.length,
    unexaminedRejected: unexaminedRejected.length,
    evidenceless: evidenceless.length,
    advisoriesClamped,
    inconsistentRisk: inconsistentRisk.length,
  };
}

/** The current value of one proposed field, for the skeptic's before/after. */
function effectiveFrom(tool: ExtractedTool, field: string): unknown {
  return (tool as unknown as Record<string, unknown>)[field];
}
