import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { vendoSync, type SyncReportWithWarnings } from "@vendoai/actions/sync";
import type { ToolImpact } from "../sync-impact.js";
import {
  pushHostComponents,
  readPushComponents,
  writePushComponents,
} from "./cloud/host-components.js";
import { pushPinBaselines } from "./cloud/pin-baselines.js";
import { AGENT_ENDPOINT_ENV_VAR } from "./extract/gateway-fuel.js";
import type { ThemeStageInput } from "./extract/stages.js";
import { runProseStages } from "./init-judgment.js";
import { selectJudgmentEngines, type AvailableEngine } from "./judge/engine.js";
import { runJudgmentPass, type JudgmentPassOptions } from "./judge/pass.js";
import { plainSelect, type SelectOption } from "./pretty.js";
import {
  extractTheme,
  toVendoTheme,
  type modelThemeSchema,
  type ThemeSlotValues,
  type ThemeSummary,
} from "./theme/extract-theme.js";
import { baseFrom, mergeExtraction, readBase, writeBase } from "./theme/provenance.js";
import { askYesNo, exists, parseDotEnv, readOptional, writeText, type Output } from "./shared.js";

/**
 * THE flow both `vendo init` (mode "full" — a fresh install has judged nothing)
 * and `vendo sync` (mode "incremental" — only what moved) run: extraction, the
 * theme path, ONE consent question, the judgment pass, the report, the impact
 * check, and the keyed Cloud pushes.
 *
 * Everything in here is fail-soft, exactly as it is today; the CALLERS own the
 * exit codes, and the two postures stay deliberately different (init fails
 * loud with 1, sync fails soft with 0 so a sync problem never breaks a build).
 */

/** The telemetry `engine` enum value for each ladder rung (both Claude rungs
    are the same engine reached two ways). Unlisted ids (test seams) map to
    undefined — init's "none" default covers them. Distinct from the
    user-facing `--engine` family, which says "npx" where telemetry's closed
    enum says "npx-engine". */
const ENGINE_BY_HARNESS_ID: Record<string, "claude" | "codex" | "npx-engine"> = {
  "claude-agent-sdk": "claude",
  "claude-cli": "claude",
  "codex-cli": "codex",
  "npx-engine": "npx-engine",
};

export interface SyncFlowOptions {
  root: string;
  /** Human narration. A caller that owns its stdout byte-for-byte (`sync
   *  --json`) passes a silent sink and reads `notes` off the result instead. */
  output: Output;
  /** init → full (a fresh install has judged nothing); sync → incremental. */
  mode: "full" | "incremental";
  interactive: boolean;
  yes: boolean;
  ai?: boolean;
  engine?: string;
  force?: boolean;
  themeRefresh?: boolean;
  review?: boolean;
  apiKey?: string;
  apiUrl?: string;
  /** The dev server the impact check asks about. */
  url?: string;
  pushComponents?: boolean;
  sync?: typeof vendoSync;
  fetchImpl?: typeof fetch;
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
  choose?: (question: string, options: SelectOption[], defaultIndex: number) => Promise<string>;
  judge?: Pick<JudgmentPassOptions,
    "harness" | "harnesses" | "resolveCredential" | "confirm" | "onProgress">;
  /** Test seam: the wall-clock budget for each Cloud reconcile. */
  baselineBudgetMs?: number;
}

export interface SyncFlowResult {
  report: SyncReportWithWarnings;
  judged: { ran: boolean; engine?: "claude" | "codex" | "npx-engine" };
  /** The theme re-scan: which slots this run took from the host, and which the
   *  host disagrees with but a human owns. null = nothing to reconcile (the
   *  file was just created, or there is none). */
  theme: { updated: string[]; pinned: string[] } | null;
  /** The exact-only slot summary, present only when this run CREATED the
   *  theme (init's model fill and uncertain-slot review read it). */
  themeSummary: ThemeSummary | null;
  /** What the theme stage filled into the still-open slots, when it ran. */
  themeDraft: z.infer<typeof modelThemeSchema> | null;
  /** How long the deterministic theme scan took, when this run made one. */
  themeMs?: number;
  /** The catalog on disk after this run — what telemetry counts. */
  counts: { tools: number; routes: number };
  /** [] = nothing referenced the changed tools; null = impact unknown. */
  impact: ToolImpact[] | null;
  baselines: { pushed: string[]; pruned: string[] } | null;
  components: { pushed: string[]; pruned: string[]; modules: { uploaded: number; deleted: number } } | null;
  /** CLI-level events not carried by the report, in order. */
  notes: string[];
  /** The Cloud key this run resolved (--key, else the merged env). One sync,
   *  one key — a second leg re-reading the env was #567's trap. */
  cloudKey: string | undefined;
}

/**
 * `.env` then `.env.local` (local wins), then process.env — except that a
 * BLANK process value yields to a concrete file one. THE env reader for the
 * whole CLI: init read only `.env.local` (the defect — a key in `.env` was
 * invisible and the run went structural-only with no signal why), sync read
 * both through doctor's copy, and telemetry had a third. Minimal KEY=VALUE
 * parser: `export ` prefix, matching quotes, `#` comment lines.
 *
 * ONE exception, and it is a security boundary rather than a parsing rule:
 * the files may not supply AGENT_ENDPOINT_ENV_VAR. Everything downstream
 * sees a flat map and so cannot tell a shell value from a file one; this is
 * the last point where that provenance is still known, so it is where the
 * distinction gets made. Dropping the key here (rather than filtering it at
 * each consumer) carries provenance to every rung for free: below this line
 * the only remaining source is `processEnv`, and every consumer that
 * re-merges `process.env` over its input — both Claude rungs do — therefore
 * still honors the developer's own shell endpoint.
 */
export async function readEnvFiles(
  root: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string | undefined>> {
  const fromFiles: Record<string, string> = {};
  for (const file of [".env", ".env.local"]) {
    const source = await readOptional(join(root, file));
    if (source === null) continue;
    Object.assign(fromFiles, parseDotEnv(source));
  }
  delete fromFiles[AGENT_ENDPOINT_ENV_VAR];
  const merged: Record<string, string | undefined> = { ...fromFiles, ...processEnv };
  for (const [key, value] of Object.entries(processEnv)) {
    if ((value ?? "").trim() === "" && fromFiles[key] !== undefined) merged[key] = fromFiles[key];
  }
  return merged;
}

/** The one catalog summary both commands print. */
export function printSyncReport(report: SyncReportWithWarnings, output: Output): void {
  for (const warning of report.warnings) output.error(`warning: ${warning}`);
  output.log(`tools: +${report.tools.added.length} -${report.tools.removed.length} ~${report.tools.changed.length}`);
  const { total, inputs, outputs } = report.toolSchemas;
  const blind = [...new Set([...inputs.unknown, ...outputs.unknown])].sort();
  output.log(`tool schemas: inputs ${inputs.known}/${total} · outputs ${outputs.known}/${total}`
    + (blind.length === 0
      ? ""
      : ` — blind: ${blind.slice(0, 6).join(", ")}${blind.length > 6 ? ` +${blind.length - 6} more` : ""}`));
  output.log(`pins: ${report.pins.captured.length} captured, ${report.pins.drifted.length} drifted`);
  for (const slot of report.pins.pruned ?? []) {
    output.log(`pruned: ${slot} — stale baseline deleted (no <Remixable> wrapper names this slot anymore)`);
  }
  output.log(`catalog.json: ${report.catalog.discovered} discovered, ${report.catalog.registered} registered`);
  output.log(`components: ${report.components.captured.length} captured, ${report.components.drifted.length} updated${report.components.skipped === undefined ? "" : `, ${report.components.skipped.length} skipped`}`);
  if (report.components.withoutSamples !== undefined) {
    // One line, not one warning per component: a preview with no seed is a
    // labeled placeholder, not a failure — but it IS why a component looks
    // blank in the console, so it must be visible and fixable from here.
    const names = report.components.withoutSamples;
    output.log(`components: ${names.join(", ")} ${names.length === 1 ? "declares" : "declare"} no examples, so the console can only show a labeled placeholder — add \`examples\` to ${names.length === 1 ? "its" : "their"} registration to preview ${names.length === 1 ? "it" : "them"}`);
  }
  for (const name of report.components.pruned ?? []) {
    output.log(`pruned: ${name} — stale component capture deleted (your app no longer registers it)`);
  }
  if (report.pins.drifted.length > 0) {
    // 06-apps §8 — drift never auto-rebases: the fork's owner decides.
    output.log(`drifted: ${report.pins.drifted.join(", ")} — existing forks stay on the old capture until each owner rebases (POST /apps/:id/rebase-pin or the vendo_apps_rebase_pin agent tool)`);
  }
  // A `<Remixable>` wrapper that cannot capture is a hard error (final-shape
  // spec 2026-08-02): the constraint — one statically importable child — is
  // defended loudly at sync time, never degraded silently.
  if (report.remixableErrors.length > 0) {
    output.error("error: <Remixable> wrappers that cannot be captured:");
    for (const remixableError of report.remixableErrors) output.error(`  ${remixableError}`);
  }
}

/**
 * The theme re-scan (decision 3): a rebrand must reach Vendo, but a hand edit
 * must never be clobbered. Deterministic, keyless, and fail-soft — a theme
 * problem is a note, never an exit code. See theme/provenance.ts for the law.
 */
async function reconcileTheme(
  root: string,
  vendoDir: string,
  force: boolean,
  note: (message: string) => void,
): Promise<SyncFlowResult["theme"]> {
  const raw = await readOptional(join(vendoDir, "theme.json"));
  if (raw === null) return null;
  let theme: unknown;
  try {
    theme = JSON.parse(raw);
  } catch {
    note("theme: .vendo/theme.json is not valid JSON — skipped (fix it, or delete it and re-run `vendo init`)");
    return null;
  }
  const summary = await extractTheme(root);
  const base = await readBase(vendoDir);
  const merge = mergeExtraction({ theme, base, summary, ...(force ? { force: true } : {}) });
  if (merge.theme !== null) {
    await writeText(join(vendoDir, "theme.json"), `${JSON.stringify(merge.theme, null, 2)}\n`);
  }
  // The base advances whenever this run is unambiguous — everything agreed, or
  // every disagreement was resolved. While disagreements remain unresolved it
  // stays put, so the warning repeats every sync instead of quietly baking the
  // stale value in as the new truth.
  if (merge.pinned.length === 0) await writeBase(vendoDir, baseFrom(summary));
  // One line, and every claim in it is literally true: "re-read" names ONLY
  // the slots just written to theme.json, and a pinned slot shows BOTH values
  // so nobody can read it as "your accent now tracks your CSS".
  const parts: string[] = [];
  if (merge.updated.length > 0) {
    parts.push(`${merge.updated.length} slot${merge.updated.length === 1 ? "" : "s"} re-read from your app (${merge.updated.join(", ")}) → .vendo/theme.json`);
  }
  if (merge.pinned.length > 0) {
    const detail = merge.pinned.map((entry) => `${entry.slot} — yours ${entry.mine} vs your app's ${entry.theirs}`).join("; ");
    parts.push(`${merge.pinned.length} pinned by you, unchanged (${detail}) — \`vendo sync --theme-refresh\` takes your app's values`);
  }
  if (parts.length > 0) note(`theme: ${parts.join(" · ")}`);
  return { updated: merge.updated, pinned: merge.pinned.map((entry) => entry.slot) };
}

/** The still-open brand slots the theme stage is asked to fill, plus the exact
 *  values the deterministic pass already proved — so the model fills gaps
 *  instead of second-guessing tokens the app states outright. */
function themeStageInput(summary: ThemeSummary): Pick<ThemeStageInput, "needed" | "alreadyExact" | "evidencePaths"> {
  return {
    needed: summary.needed,
    alreadyExact: Object.fromEntries(
      Object.entries(summary.matched)
        .filter(([, provenance]) => provenance.startsWith("--"))
        .map(([slot]) => [slot, String(summary.slots[slot as keyof ThemeSlotValues])]),
    ),
    evidencePaths: summary.evidencePaths,
  };
}

/** The catalog as it stands on disk, for telemetry. Unreadable degrades to
 *  zero — sync already reported any extraction warning. */
async function countCatalog(vendoDir: string): Promise<SyncFlowResult["counts"]> {
  try {
    const tools = JSON.parse(await readFile(join(vendoDir, "tools.json"), "utf8")) as {
      tools?: Array<{ binding?: { kind?: string } }>;
    };
    return {
      tools: tools.tools?.length ?? 0,
      routes: tools.tools?.filter((tool) => tool.binding?.kind === "route").length ?? 0,
    };
  } catch {
    return { tools: 0, routes: 0 };
  }
}

function impactResponse(value: unknown): ToolImpact[] {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { impact?: unknown }).impact)) {
    throw new Error("invalid sync impact response");
  }
  const impact = (value as { impact: unknown[] }).impact;
  for (const entry of impact) {
    if (typeof entry !== "object" || entry === null) throw new Error("invalid sync impact response");
    const candidate = entry as Partial<ToolImpact>;
    if (typeof candidate.tool !== "string" || !Array.isArray(candidate.apps)
      || !Array.isArray(candidate.automations) || typeof candidate.grants !== "number") {
      throw new Error("invalid sync impact response");
    }
  }
  return impact as ToolImpact[];
}

function printImpact(output: Output, impact: ToolImpact[]): void {
  for (const entry of impact) {
    const categories = [
      [entry.automations.length, "automation"],
      [entry.apps.length, "app"],
      [entry.grants, "grant"],
    ] as const;
    const references = categories
      .filter(([count]) => count > 0)
      .map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`);
    output.log(references.length === 0
      ? `impact: ${entry.tool} no saved references`
      : `impact: ${entry.tool} breaks ${references.join(", ")}`);
  }
}

/**
 * ONE consent, one wording, both commands (decision 2): `--ai` runs the pass
 * with no prompt, `--no-ai` refuses it, and with neither flag an interactive
 * run ASKS — every run, because no answer is ever persisted — while a run that
 * cannot ask skips, so CI builds stay deterministic and never spend.
 *
 * The engine ladder is walked when there is a question to ask, and — in `full`
 * mode only — also under `--ai`: a one-time install must SAY what the machine
 * is missing ("AI polish: unavailable") instead of degrading in silence.
 * `vendo sync` runs in predev on every dev-server start, so an incremental
 * `--ai` run never probes a single harness; the pass resolves its own engine
 * behind its credential gate instead.
 */
async function chooseEngine(
  options: SyncFlowOptions,
  env: Record<string, string | undefined>,
  note: (message: string) => void,
): Promise<{ skip: true } | { skip: false; engine?: AvailableEngine }> {
  const { output } = options;
  if (options.ai === false) {
    output.log("AI polish (descriptions, risk review, brief, theme): off (--no-ai) — extractor defaults stand.");
    return { skip: true };
  }
  if (options.ai !== true && (options.yes || !options.interactive)) {
    note("judgment: skipped — this run cannot ask (pass `--ai` to judge non-interactively, `--no-ai` to say so explicitly)");
    return { skip: true };
  }
  // An explicitly supplied harness IS the choice — the ladder has nothing left
  // to discover, and walking it would probe the machine for engines the caller
  // already declined to use.
  if (options.ai === true && (options.mode !== "full" || options.judge?.harness !== undefined)) {
    return { skip: false };
  }

  const available = await selectJudgmentEngines({
    root: options.root,
    env,
    ...(options.judge?.harnesses === undefined ? {} : { harnesses: options.judge.harnesses }),
  });
  if (available.length === 0) {
    output.log("AI polish: unavailable — needs Claude Code installed (`npm install -g @anthropic-ai/claude-code`) or @anthropic-ai/claude-agent-sdk resolvable, plus a Claude Code login or ANTHROPIC_API_KEY; or the `codex` CLI installed, plus a codex login (`codex login`) or OPENAI_API_KEY; or a VENDO_API_KEY (`vendo login`), which fetches Claude Code on the fly via npx. Extractor defaults stand; re-run `vendo init` once set up.");
    return { skip: true };
  }

  // --engine pins a family. An unavailable pin never falls back to another
  // provider (the pin is usually a privacy/policy choice about where source
  // goes) — one loud line naming what IS available, exit code untouched.
  let chosen = available[0]!;
  if (options.engine !== undefined) {
    const pinned = available.find((entry) => entry.family === options.engine);
    if (pinned === undefined) {
      const alternatives = available
        .map((entry) => `\`--engine ${entry.family}\` (${entry.credential})`)
        .join(", or ");
      output.log(`AI polish: \`--engine ${options.engine}\` requested but that engine isn't available on this machine. Available: ${alternatives}. Extractor defaults stand; re-run \`vendo init\` once it's set up.`);
      return { skip: true };
    }
    chosen = pinned;
  }

  // `--ai` IS the answer: the ladder was walked only to report what is here.
  if (options.ai === true) return { skip: false, engine: chosen };

  if (options.engine === undefined && available.length > 1) {
    // Several engines: the SAME single consent question, as a pick-with-
    // default instead of yes/no — never a second question.
    const choose = options.choose ?? plainSelect;
    const picked = await choose(
      "Let a coding agent read this codebase to draft tool descriptions, review risk, write the product brief, and fill unresolved theme slots? Source goes to the chosen provider under your account.",
      [
        ...available.map((entry) => ({ value: entry.family, label: entry.credential, hint: `--engine ${entry.family}` })),
        { value: "skip", label: "Skip — keep extractor defaults" },
      ],
      0,
    );
    const selected = available.find((entry) => entry.family === picked);
    if (selected === undefined) {
      output.log("Skipped — extractor defaults stand; re-run `vendo init` any time to add the AI polish.");
      return { skip: true };
    }
    chosen = selected;
  } else {
    const confirm = options.judge?.confirm ?? options.confirm ?? askYesNo;
    const consented = await confirm(
      `Let ${chosen.credential} read this codebase to draft tool descriptions, review risk, write the product brief, and fill unresolved theme slots? Source goes to your model provider under your account.`,
      true,
    );
    if (!consented) {
      output.log("Skipped — extractor defaults stand; re-run `vendo init` any time to add the AI polish.");
      return { skip: true };
    }
  }
  return { skip: false, engine: chosen };
}

export async function runSyncFlow(options: SyncFlowOptions): Promise<SyncFlowResult> {
  const { root, output, mode } = options;
  const vendoDir = join(root, ".vendo");
  // CLI-level events, in order: printed here AND returned, so `sync --json`
  // can carry them in its one object without a second channel.
  const notes: string[] = [];
  const note = (message: string): void => { notes.push(message); output.log(message); };
  const noteError = (message: string): void => { notes.push(message); output.error(message); };

  // The credential env for the judgment pass and the Cloud key: the project's
  // dotenv must be visible, because `vendo login` and BYO keys land in
  // `.env.local` / `.env` and a fresh shell that never `source`d them would
  // otherwise sync structural-only with no signal why (#567).
  const env = await readEnvFiles(root);

  const report: SyncReportWithWarnings = await (options.sync ?? vendoSync)({
    root,
    out: vendoDir,
    // The CLI needs the report to compute exit 2 vs 3; it applies strictness.
    strict: false,
  });
  printSyncReport(report, output);

  // Theme, ONE path: init's install creates the file (it is the editable source
  // of truth from then on), and every later run reconciles it — a rebrand
  // reaches Vendo, a hand edit is never clobbered.
  const themePath = join(vendoDir, "theme.json");
  let themeSummary: ThemeSummary | null = null;
  let themeMs: number | undefined;
  let theme: SyncFlowResult["theme"] = null;
  if (mode === "full" && (options.force === true || !(await exists(themePath)))) {
    const themeStarted = Date.now();
    themeSummary = await extractTheme(root);
    themeMs = Date.now() - themeStarted;
    await writeText(themePath, `${JSON.stringify(toVendoTheme(themeSummary.slots), null, 2)}\n`);
    // The merge base for every later re-scan: what the DETERMINISTIC pass read,
    // before any model fill or --theme answer — those are decisions, and the
    // reconcile must pin them (theme/provenance.ts).
    await writeBase(vendoDir, baseFrom(themeSummary));
  } else {
    theme = await reconcileTheme(root, vendoDir, options.themeRefresh === true, note);
  }

  // The judgment pass: grade the freshly synced catalog, with a verbatim quote
  // behind every proposal and an independent skeptic checking each one.
  // Hardenings and prose apply themselves; loosenings wait for a human —
  // `--review` (or an attended run) asks now, otherwise they queue as
  // `pending`. Keyless resolves to one structural-only line.
  const judged: SyncFlowResult["judged"] = { ran: false };
  let themeDraft: SyncFlowResult["themeDraft"] = null;
  const selection = await chooseEngine(options, env, note);
  if (!selection.skip) {
    // A one-time install narrates the slowest step it is about to take; an
    // incremental sync stays as quiet as it is today.
    if (mode === "full" && selection.engine !== undefined) {
      output.log(`\nReading your product (${selection.engine.credential})…`);
    }
    try {
      // `--yes` means every question is already answered, so it must not reach
      // the aggregated loosening review either: an unattended run cannot
      // answer, and the guard law forbids lowering risk without a human, so
      // loosenings queue instead — and no `confirm` is handed down at all, so
      // nothing downstream can acquire a way to block.
      const attended = options.interactive && !options.yes;
      const loosenings = attended || options.review === true ? "review" : "queue";
      const pass = await runJudgmentPass({
        root,
        out: vendoDir,
        mode,
        loosenings,
        env,
        output: { log: note, error: noteError },
        ...(options.engine === undefined ? {} : { engine: options.engine }),
        ...(selection.engine === undefined
          ? (options.judge?.harness === undefined ? {} : { harness: options.judge.harness })
          : { harness: selection.engine.harness }),
        ...(loosenings === "review" ? { confirm: options.judge?.confirm ?? options.confirm ?? askYesNo } : {}),
        ...(options.judge?.harnesses === undefined ? {} : { harnesses: options.judge.harnesses }),
        ...(options.judge?.resolveCredential === undefined ? {} : { resolveCredential: options.judge.resolveCredential }),
        ...(options.judge?.onProgress === undefined ? {} : { onProgress: options.judge.onProgress }),
      });
      // The pass already printed the count and `vendo sync --review`; say WHY
      // they were held, so an unattended caller doesn't read it as a refusal.
      if (loosenings === "queue" && pass.status === "judged" && pass.queued > 0) {
        note("  (held, not applied: this run had no one to ask — re-run `vendo init` in a terminal to review them inline)");
      }
      judged.ran = true;
      const engine = selection.engine === undefined ? undefined : ENGINE_BY_HARNESS_ID[selection.engine.harness.id];
      if (engine !== undefined) judged.engine = engine;
    } catch (error) {
      note(`judgment failed soft: ${error instanceof Error ? error.message : "unknown error"}`);
      judged.ran = false;
    }

    // The prose stages — the product brief and the theme fill — read the GRADED
    // catalog, so they run after the pass. Full mode only: `vendo sync` in
    // predev must not redraft a brief on every dev-server start.
    if (mode === "full" && selection.engine !== undefined) {
      const stages = await runProseStages({
        root,
        output,
        env,
        harness: selection.engine.harness,
        tools: await exists(join(vendoDir, "tools.json")),
        ...(options.force === true ? { force: true } : {}),
        ...(themeSummary === null ? {} : { theme: themeStageInput(themeSummary) }),
      });
      themeDraft = stages.theme ?? null;
    }
  }

  const wireUrl = (options.url ?? process.env.VENDO_URL ?? "http://localhost:3000/api/vendo").replace(/\/+$/, "");
  const tools = [...new Set([
    ...report.breaking.map((breaking) => breaking.tool),
    ...report.tools.changed,
  ])];
  let impact: ToolImpact[] | null = tools.length === 0 ? [] : null;
  if (tools.length > 0) {
    try {
      const response = await (options.fetchImpl ?? fetch)(`${wireUrl}/sync/impact`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ tools }),
      });
      if (!response.ok) throw new Error(`sync impact returned ${response.status}`);
      impact = impactResponse(await response.json());
      printImpact(output, impact);
    } catch {
      note(`impact unknown — dev server not reachable at ${wireUrl}`);
    }
  }

  // Pin baselines → Vendo Cloud (decision 4). Part of a NORMAL keyed run, not
  // something `--report` gates: the console's Remix reviews screen cannot show
  // a fork's diff without the host baseline it forked from. Keyless/BYO makes
  // no request at all, and a Cloud hiccup is a note — never a failed build.
  const cloudKey = options.apiKey ?? env.VENDO_API_KEY;
  const keyed = cloudKey !== undefined && cloudKey.trim() !== "";
  // No `.vendo/remixable/` at all means this host has never had a wrapper —
  // nothing to push, and nothing Cloud could be holding to prune.
  let baselines: SyncFlowResult["baselines"] = null;
  if (await exists(join(vendoDir, "remixable"))) {
    if (keyed) {
      // Never throws: whatever landed before a failure is still accounted for.
      const result = await pushPinBaselines({
        vendoDir,
        apiKey: cloudKey!,
        ...(options.apiUrl === undefined ? {} : { baseUrl: options.apiUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.baselineBudgetMs === undefined ? {} : { budgetMs: options.baselineBudgetMs }),
      });
      baselines = { pushed: result.pushed, pruned: result.pruned };
      if (result.unreadable.length > 0) {
        // A file that exists but won't parse is a half-written capture, not a
        // deleted slot — its Cloud row was deliberately left in place.
        noteError(`warning: unreadable baselines left untouched in Vendo Cloud: ${result.unreadable.join(", ")} — re-run sync to recapture .vendo/remixable/<slot>.json`);
      }
      if (result.pushed.length > 0 || result.pruned.length > 0) {
        note(`baselines → Vendo Cloud: ${result.pushed.length} pushed, ${result.pruned.length} pruned (component source crosses the wire so the console can review forks)`);
      }
      if (result.error !== undefined) {
        noteError(`warning: pin baselines did not fully reach Vendo Cloud: ${result.error} — the rest stay in .vendo/remixable/ and the next sync retries`);
      }
    } else {
      // Captures exist but this environment has no key. Keyless is a supported
      // path (BYO), so this is a statement of fact rather than a warning — but
      // it must be SAID: a build env that lacks the key the runtime has pushes
      // nothing, and the console then shows a fork it cannot diff.
      note("baselines stay local — no Vendo Cloud key in this environment; Cloud's Remix reviews screen needs a keyed sync to diff forks");
    }
  }

  // Registered host components → Vendo Cloud. The project answers once and the
  // answer is committed with the rest of `.vendo/`. Keyless/BYO never asks and
  // never uploads.
  let components: SyncFlowResult["components"] = null;
  if (keyed && await exists(join(vendoDir, "components"))) {
    let allowed = options.pushComponents ?? await readPushComponents(vendoDir);
    if (allowed === undefined) {
      allowed = options.interactive && await (options.confirm ?? askYesNo)(
        "Send this project's registered host components to Vendo Cloud, so the console renders them instead of grey placeholders? Their source and your app-root CSS cross the wire; package code never does. Saved to .vendo/cloud.json — asked once.",
        true,
      );
      if (options.interactive) await writePushComponents(vendoDir, allowed);
      else note("components: not pushed — this run cannot ask (pass `--push-components` in CI, or run `vendo sync` once in a terminal to decide)");
    }
    if (allowed) {
      const result = await pushHostComponents({
        vendoDir,
        apiKey: cloudKey!,
        ...(options.apiUrl === undefined ? {} : { baseUrl: options.apiUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.baselineBudgetMs === undefined ? {} : { budgetMs: options.baselineBudgetMs }),
      });
      components = { pushed: result.pushed, pruned: result.pruned, modules: result.modules };
      if (result.unreadable.length > 0) {
        noteError(`warning: unreadable component captures left untouched in Vendo Cloud: ${result.unreadable.join(", ")} — re-run sync to recapture .vendo/components/<Name>.json`);
      }
      if (result.pushed.length > 0 || result.pruned.length > 0 || result.modules.uploaded > 0) {
        note(`components → Vendo Cloud: ${result.pushed.length} pushed, ${result.pruned.length} pruned, ${result.modules.uploaded} new module${result.modules.uploaded === 1 ? "" : "s"} (${Math.round(result.uploadedBytes / 1024)} KB)`);
      }
      if (result.error !== undefined) {
        noteError(`warning: host components did not fully reach Vendo Cloud: ${result.error} — the rest stay in .vendo/components/ and the next sync retries`);
      }
    }
  } else if (await exists(join(vendoDir, "components"))) {
    // Same statement of fact #765 makes for baselines, for the same reason: a
    // build env without the key its runtime has pushes nothing, and the console
    // then draws grey placeholders with no host-side signal why.
    note("components stay local — no Vendo Cloud key in this environment; the console needs a keyed sync to render your components instead of placeholders");
  }

  return {
    report,
    judged,
    theme,
    themeSummary,
    themeDraft,
    ...(themeMs === undefined ? {} : { themeMs }),
    counts: await countCatalog(vendoDir),
    impact,
    baselines,
    components,
    notes,
    cloudKey,
  };
}
