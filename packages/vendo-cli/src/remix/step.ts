/**
 * The remix picker STEP — the second interactive picker in `vendo init` (the
 * catalog picker is the first). It wires discovery (discover.ts) to the splice
 * codemod (anchor.ts): the LLM proposes widget-shaped client components a
 * developer's END USERS might want to customize, the picker lets the developer
 * choose (all pre-checked), and each pick is wrapped in a `<VendoRemix id label>`
 * anchor IN THE HOST SOURCE. Because it edits user source files, this step is
 * HUMAN-GATED: it runs only in an interactive `vendo init`/`vendo refresh`, never
 * under `--yes`/non-TTY/CI (those paths print {@link REMIX_HINT} instead).
 *
 * Fail-open by design — a splice that hits any ambiguity, or a per-file read/
 * write error, is reported as SKIPPED (with manual instructions) and never
 * crashes init. A splice that fails the syntax gate never writes.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LanguageModel } from "ai";
import type { Interactor } from "../interact.js";
import { discoverRemixCandidates, type RemixCandidate, type RemixDiscovery } from "./discover.js";
import { spliceRemixAnchor, remixContextTodo } from "./anchor.js";

/** Picker hints render inline next to the checkbox — keep them one short line. */
const MAX_HINT_CHARS = 72;
function truncateHint(reason: string): string {
  return reason.length > MAX_HINT_CHARS ? `${reason.slice(0, MAX_HINT_CHARS - 1).trimEnd()}…` : reason;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A successfully wrapped anchor. */
export interface RemixWrapped {
  id: string;
  label: string;
  /** targetDir-relative source path that got the anchor. */
  file: string;
}

/** A picked candidate that was NOT wrapped (splice ambiguity or IO error). */
export interface RemixSkipped {
  componentName: string;
  /** targetDir-relative source path, or "" for a step-level failure. */
  file: string;
  reason: string;
  /** By-hand instructions to paste (empty for an IO/discovery failure). */
  manual: string;
}

/**
 * Outcome of the remix step. `wrapped`/`skipped` are the seam Task 17 reads for
 * telemetry counts (the completed-event will include their lengths); nothing
 * here is printed by the step itself — {@link renderRemixStep} does that.
 */
export interface RemixStepResult {
  wrapped: RemixWrapped[];
  skipped: RemixSkipped[];
  /** The picker was cancelled (Ctrl-C) — nothing was wrapped. */
  cancelled: boolean;
  /** How many candidates discovery offered (0 => nothing to pick). */
  candidateCount: number;
  /** Discovery-time proposals dropped by a hard exclusion (reported, not shown). */
  excluded: RemixDiscovery["excluded"];
}

/** Labels are component names; duplicates get the rel path appended so identical
 *  names never render identical rows (mirrors the catalog picker). */
function labelForFactory(candidates: RemixCandidate[]): (c: RemixCandidate) => string {
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.componentName, (counts.get(c.componentName) ?? 0) + 1);
  return (c) => ((counts.get(c.componentName) ?? 0) > 1 ? `${c.componentName} (${c.file})` : c.componentName);
}

/**
 * Discover, prompt, and splice. NEVER throws — discovery failure, an ambiguous
 * splice, or a per-file IO error all collapse into a `skipped` entry so init
 * keeps going. The caller decides IF this runs (only with a model AND an
 * interactive, non-`--yes` run); this function assumes it may prompt.
 */
export async function runRemixStep(
  targetDir: string,
  model: LanguageModel,
  interactor: Interactor,
): Promise<RemixStepResult> {
  const base: RemixStepResult = { wrapped: [], skipped: [], cancelled: false, candidateCount: 0, excluded: [] };

  let discovery: RemixDiscovery;
  try {
    discovery = await discoverRemixCandidates(targetDir, model);
  } catch (err) {
    // Discovery is best-effort — a provider hiccup must not fail init.
    return { ...base, skipped: [{ componentName: "(remix discovery)", file: "", reason: errorMessage(err), manual: "" }] };
  }

  if (discovery.candidates.length === 0) {
    return { ...base, excluded: discovery.excluded };
  }

  const labelFor = labelForFactory(discovery.candidates);
  const selection = await interactor.multiSelect({
    message: "Select widgets to make remixable — wraps each in a <VendoRemix> anchor in your source",
    options: discovery.candidates.map((c) => ({
      value: c.file, // the file is the unique, invisible value; the label is the component name
      label: labelFor(c),
      hint: truncateHint(c.reason),
    })),
    // All pre-checked: the LLM already filtered to good candidates.
    initialValues: discovery.candidates.map((c) => c.file),
    // Empty selection is a legitimate answer (wrap nothing); distinct from
    // cancel (null), which skips the whole step.
    required: false,
  });

  if (selection === null) {
    return { ...base, cancelled: true, candidateCount: discovery.candidates.length, excluded: discovery.excluded };
  }

  const picked = new Set(selection);
  const chosen = discovery.candidates.filter((c) => picked.has(c.file));
  const wrapped: RemixWrapped[] = [];
  const skipped: RemixSkipped[] = [];

  for (const c of chosen) {
    const abs = path.join(targetDir, c.file);
    let source: string;
    try {
      source = await fs.readFile(abs, "utf8");
    } catch (err) {
      skipped.push({ componentName: c.componentName, file: c.file, reason: `couldn't read the file (${errorMessage(err)})`, manual: "" });
      continue;
    }
    const result = spliceRemixAnchor(source, {
      componentName: c.componentName,
      id: c.suggestedId,
      label: c.suggestedLabel,
      fileName: c.file,
    });
    if (!result.ok) {
      skipped.push({ componentName: c.componentName, file: c.file, reason: result.reason, manual: result.manual });
      continue;
    }
    try {
      // A USER source file (not a .vendo artifact) — plain fs write, no writeGenerated.
      await fs.writeFile(abs, result.code, "utf8");
    } catch (err) {
      skipped.push({ componentName: c.componentName, file: c.file, reason: `couldn't write the file (${errorMessage(err)})`, manual: "" });
      continue;
    }
    wrapped.push({ id: c.suggestedId, label: c.suggestedLabel, file: c.file });
  }

  return { wrapped, skipped, cancelled: false, candidateCount: discovery.candidates.length, excluded: discovery.excluded };
}

/** The console block for a remix step that RAN (active path). Always returns a
 *  line so the run says something: a quiet line when nothing was offered, the
 *  per-anchor TODOs + summary otherwise. */
export function renderRemixStep(r: RemixStepResult): string {
  if (r.cancelled) {
    return "remix picker skipped — nothing wrapped.";
  }
  // Quiet ONLY when there was genuinely nothing to offer AND no failure — a
  // discovery error lands as a `skipped` entry with candidateCount 0 and must
  // still be surfaced below, not swallowed by this line.
  if (r.candidateCount === 0 && r.skipped.length === 0) {
    return "remix anchors: no widget-shaped components found to wrap.";
  }
  const lines: string[] = [];
  if (r.wrapped.length > 0) {
    lines.push(`remix anchors: ${r.wrapped.length} wrapped`);
    for (const w of r.wrapped) lines.push(`  ${w.id} <- ${w.file}`);
    for (const w of r.wrapped) lines.push(`  TODO ${remixContextTodo(w.id)}`);
  } else {
    lines.push("remix anchors: nothing wrapped.");
  }
  for (const s of r.skipped) {
    lines.push(`  skipped ${s.componentName}${s.file ? ` (${s.file})` : ""}: ${s.reason}`);
    if (s.manual) lines.push(...s.manual.split("\n").map((l) => `    ${l}`));
  }
  if (r.wrapped.length > 0) {
    lines.push("`vendo sync` will capture baselines for the wrapped widgets on your next build.");
  }
  return lines.join("\n");
}

/** Printed on any run that did NOT open the remix picker (`--yes`, non-TTY/CI,
 *  or no model). Source edits stay human-gated — point the developer at the
 *  interactive path and the by-hand escape hatch. */
export const REMIX_HINT = [
  "",
  "Remix anchors (let your users customize a widget on the live site) are offered only in an",
  "interactive run — they edit your source, so they stay human-gated. Run `vendo init` or",
  "`vendo refresh` in a terminal to pick them, or wrap a widget by hand with <VendoRemix> (see the remix docs).",
].join("\n");
