/**
 * Remix candidate discovery — the proposal half of the `vendo init` remix
 * picker (the splice codemod is Task 11, the picker wiring Task 12).
 *
 * A `<VendoRemix id label>` anchor wraps existing host JSX so end users can
 * customize that widget on the live site (see sync/capture.ts). This module
 * finds GOOD candidates to wrap: widget-shaped, client-rendered blocks inside
 * the app's source tree.
 *
 * Flow: a deterministic scan collects plausible `.tsx/.jsx` source files → ONE
 * batch LLM call proposes widget-shaped candidates with a suggested id/label +
 * one-line reason (mirrors components/analyze.ts's proposeComponents) →
 * deterministic HARD EXCLUSIONS are applied AFTER the LLM (fail-closed: a
 * proposal for an excluded file is DROPPED with a reason, never passed
 * through). Pure discovery — reads only, writes nothing.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { walk } from "../fsx.js";
import { generateJson } from "../llm.js";
import { refusalReason, resolveSourceRoot } from "../sync/capture.js";
import { inspectVendoState } from "../state.js";

export interface RemixCandidate {
  /** Path relative to targetDir, forward slashes. */
  file: string;
  /** The file's first exported component name (label fallback). */
  componentName: string;
  /** Sanitized kebab-case id, unique across the returned candidates. */
  suggestedId: string;
  /** Human label for the picker. */
  suggestedLabel: string;
  /** One line shown next to the checkbox. */
  reason: string;
}

export interface RemixDiscovery {
  candidates: RemixCandidate[];
  /** Proposals dropped by a hard exclusion, with why (reported, not shown). */
  excluded: Array<{ file: string; reason: string }>;
}

interface SourceFile {
  /** Absolute path. */
  file: string;
  /** Path relative to targetDir, forward slashes. */
  relFile: string;
  componentName: string;
  source: string;
}

// A component candidate is a file with a PascalCase named export (function or
// const, like components/scan.ts) OR a named default-export function — widgets
// are commonly default-exported. Anonymous default exports carry no name to
// label with, so they're skipped.
const NAMED_EXPORT_RE = /export\s+(?:function|const)\s+([A-Z][A-Za-z0-9]*)/;
const DEFAULT_FN_RE = /export\s+default\s+function\s+([A-Z][A-Za-z0-9]*)/;
const MAX_FILE_BYTES = 40_000;
const DEFAULT_MAX_CANDIDATES = 40;
/** Keep the batch prompt bounded: a per-file snippet, not the whole file. */
const PROPOSAL_SNIPPET_BYTES = 1200;

function componentNameOf(source: string): string | undefined {
  return source.match(NAMED_EXPORT_RE)?.[1] ?? source.match(DEFAULT_FN_RE)?.[1];
}

/** Collect plausible widget source files under the app SOURCE root — the same
 *  root sync/capture evaluates its threat model against, so discovery can
 *  never propose a file capture would refuse as outside-root. fsx.walk already
 *  skips node_modules/.vendo/.next/dist/… and dotdirs. relFile stays
 *  targetDir-relative (state.ts anchors and picker output use that base). */
async function scanSourceFiles(targetDir: string, sourceRoot: string, max: number): Promise<SourceFile[]> {
  const files = await walk(
    sourceRoot,
    (rel) => {
      const p = rel.replace(/\\/g, "/");
      return /\.(tsx|jsx)$/.test(p) && !/\.(test|spec|stories)\.(tsx|jsx)$/.test(p);
    },
    2_000,
  );
  const out: SourceFile[] = [];
  for (const file of files) {
    if (out.length >= max) break;
    let source: string;
    try {
      source = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    if (source.length > MAX_FILE_BYTES) continue; // giant files aren't self-contained widgets
    const componentName = componentNameOf(source);
    if (!componentName) continue;
    out.push({
      file,
      relFile: path.relative(targetDir, file).split(path.sep).join("/"),
      componentName,
      source,
    });
  }
  return out;
}

export const remixProposalSchema = z.object({
  proposals: z.array(
    z.object({
      /** The candidate's relFile, echoed back so we can map the reply. */
      file: z.string(),
      /** Suggested anchor id (sanitized to kebab-case post-LLM). */
      id: z.string(),
      /** Suggested human label. */
      label: z.string(),
      /** One-line reason a user would customize this widget. */
      reason: z.string().min(1),
    }),
  ),
});

function buildPrompt(files: SourceFile[]): string {
  const blocks = files.map((f) => {
    const snippet =
      f.source.length > PROPOSAL_SNIPPET_BYTES
        ? `${f.source.slice(0, PROPOSAL_SNIPPET_BYTES)}\n… (truncated)`
        : f.source;
    return [`--- ${f.relFile} (component: ${f.componentName}) ---`, snippet].join("\n");
  });
  return [
    "You are helping a developer pick widget-shaped UI blocks on their site that END USERS may want",
    "to customize. A good candidate is a SELF-CONTAINED visual block — a list, card, table, panel, or",
    "summary — rendered CLIENT-SIDE. Skip pages, layouts, providers, route handlers, forms tied to",
    "server actions, and anything that is mostly plumbing.",
    "",
    "Propose ONLY the files worth wrapping (omit the rest). For each proposed file give:",
    "- file: the path echoed EXACTLY as in the header,",
    '- id: a short kebab-case identifier (e.g. "deadline-list"),',
    '- label: a human label shown in a picker (e.g. "Deadline list"),',
    "- reason: ONE short line on why a user would customize it.",
    "",
    "Respond with ONLY JSON:",
    '{"proposals":[{"file":"<path>","id":"deadline-list","label":"Deadline list","reason":"one short line"}]}',
    "",
    ...blocks,
  ].join("\n");
}

/** kebab-case, [a-z0-9-] only, no leading/trailing/duplicate dashes. */
function sanitizeId(raw: string): string {
  return raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `base`, or `base-2`, `base-3`, … until unused. Records the winner. */
function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

/**
 * Discover widget-shaped remix candidates in `targetDir`. `model` is required
 * (non-null) — Task 12 only calls this when a model exists. Zero scanned files
 * short-circuits to an empty result with NO LLM call.
 */
export async function discoverRemixCandidates(
  targetDir: string,
  model: LanguageModel,
  opts: { maxCandidates?: number } = {},
): Promise<RemixDiscovery> {
  // Resolve the source root EXACTLY the way sync/capture does — a mismatch
  // would let discovery offer anchors that capture later refuses to sync.
  const sourceRoot = resolveSourceRoot(targetDir);
  const files = await scanSourceFiles(targetDir, sourceRoot, opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  if (files.length === 0) return { candidates: [], excluded: [] };

  const { proposals } = await generateJson({
    model,
    schema: remixProposalSchema,
    prompt: buildPrompt(files),
  });

  const byRelFile = new Map(files.map((f) => [f.relFile, f]));
  // Reuse state.ts's anchor detection — don't re-derive which files are wrapped.
  const state = await inspectVendoState(targetDir);
  const anchoredFiles = new Set(state.remixAnchors.map((a) => a.file));

  const candidates: RemixCandidate[] = [];
  const excluded: Array<{ file: string; reason: string }> = [];
  const usedIds = new Set<string>();
  const producedFiles = new Set<string>();

  for (const p of proposals) {
    const relFile = p.file.replace(/\\/g, "/");
    // 5. Hallucination guard: the proposal must name a scanned source file.
    const src = byRelFile.get(relFile);
    if (!src) {
      excluded.push({ file: relFile, reason: "not a scanned app source file" });
      continue;
    }
    if (producedFiles.has(relFile)) continue; // duplicate proposal — first wins
    // 1+2. Server-only directive or a server/ / api/ path segment — the
    // discovery-time subset of sync/capture's refusal, evaluated against the
    // SAME source root capture uses. (refusalReason's outside-root branch
    // never fires here: scanned files always live under sourceRoot, so
    // out-of-root files are caught by scan-scoping + the hallucination guard.)
    const refusal = refusalReason(src.file, src.source, sourceRoot);
    if (refusal) {
      excluded.push({ file: relFile, reason: refusal });
      continue;
    }
    // 4. Already wrapped in a VendoRemix anchor.
    if (anchoredFiles.has(relFile)) {
      excluded.push({ file: relFile, reason: "already has a VendoRemix anchor" });
      continue;
    }
    const base = sanitizeId(p.id) || sanitizeId(src.componentName) || "widget";
    producedFiles.add(relFile);
    candidates.push({
      file: relFile,
      componentName: src.componentName,
      suggestedId: uniqueId(base, usedIds),
      suggestedLabel: p.label.trim() || src.componentName,
      reason: p.reason.trim(),
    });
  }

  return { candidates, excluded };
}
