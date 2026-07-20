import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { findAppRouter } from "./layers/structural.js";

export interface VendoRootPasteResult {
  applied: boolean;
  file: string | null;
  reason: string;
}

const LAST_STEPS_HEADER = "Last steps are yours:";
const WRAP_LINE = /…\s*then wrap:\s*(.+)$/;
// Tolerates formatting whitespace — a layout rendering `{ children }` is as
// paste-able as `{children}` (corpus-triage review finding: cubic P2).
const CHILDREN_EXPRESSION = /\{\s*children\s*\}/g;
// A module directive prologue line ('use client', "use strict", ...),
// optionally carrying a trailing comment. Pasted imports must land AFTER it:
// a directive preceded by an import is a no-op string literal, silently
// demoting a client layout to a server component (corpus-triage review
// finding: cubic P1; trailing comments + comment prefixes from the PR #441
// review round).
const DIRECTIVE_LINE = /^\s*(['"])use [a-z][a-z0-9 -]*\1;?\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/;

/** Index of the first line AFTER the module's directive prologue (0 when the
 * file has none) — directives sit at the top, possibly preceded or separated
 * by blank lines and comments (a license header before 'use client' is still
 * a valid prologue), and end at the first line of real code. */
function directivePrologueEnd(lines: readonly string[]): number {
  let end = 0;
  let inBlockComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    if (!DIRECTIVE_LINE.test(line)) break;
    end = index + 1;
  }
  return end;
}

/** The block init prints (see packages/vendo/src/cli/init.ts's
 * vendoRootPasteLines, wrapped by output.log under the "Last steps are
 * yours:" header): everything from that header up to the next blank line. */
function extractPasteBlock(output: string): string[] | null {
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === LAST_STEPS_HEADER);
  if (headerIndex === -1) return null;
  const block: string[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") break;
    block.push(line);
  }
  return block;
}

/** Deliberately dumb string surgery that mirrors the ONE paste `vendo init`
 * prints and no longer performs itself (init dropped its layout codemod —
 * see f2c23568; init.ts's vendoRootPasteLines is the source of truth for
 * what a human is told to paste). The corpus harness plays that human: it
 * reads the exact lines init printed to stdout this run and pastes them,
 * so a green corpus run still means the app is wired end to end, not just
 * that init exited 0. This is not a codemod — it does no parsing beyond the
 * printed block and the app-router path the harness already resolves for
 * the files.expected check (see layers/structural.ts's findAppRouter). */
export async function applyVendoRootPaste(
  repoDir: string,
  framework: "next" | "express" | undefined,
  initStdout: string,
): Promise<VendoRootPasteResult> {
  if ((framework ?? "next") === "express") {
    return {
      applied: false,
      file: null,
      reason: "express host — init prints server/client wiring lines, not a layout file to paste into",
    };
  }

  const app = await findAppRouter(repoDir);
  if (!app) {
    return { applied: false, file: null, reason: "no App Router root layout found — nothing to paste" };
  }

  const filePath = path.join(repoDir, app.layoutRel);
  const original = await readFile(filePath, "utf8");
  if (original.includes("<VendoRoot")) {
    return { applied: false, file: app.layoutRel, reason: "layout already wraps <VendoRoot> — left unchanged" };
  }

  const block = extractPasteBlock(initStdout);
  if (block === null) {
    throw new Error(
      `vendo init did not print the "${LAST_STEPS_HEADER}" paste instructions in its stdout; ` +
      `nothing to paste into ${app.layoutRel}`,
    );
  }

  const wrapMatch = block.map((line) => line.match(WRAP_LINE)).find((match) => match !== null);
  if (!wrapMatch) {
    throw new Error(`printed paste instructions did not include a "… then wrap:" line for ${app.layoutRel}`);
  }
  const importLines = block
    .map((line) => line.trim())
    .filter((line) => line.startsWith("import "));
  const wrapExpression = (wrapMatch[1] ?? "").trim();

  let withImports = original;
  if (importLines.length > 0) {
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const lines = original.split(/\r?\n/);
    const prologueEnd = directivePrologueEnd(lines);
    withImports = [...lines.slice(0, prologueEnd), ...importLines, ...lines.slice(prologueEnd)].join(eol);
  }
  // Replace the LAST children occurrence, not the first: a destructure
  // param — `function RootLayout({children}: ...)` — puts a "{children}"
  // in the signature ahead of the JSX one we actually want to wrap
  // (corpus-triage review finding #2). Matching withImports is equivalent to
  // matching original — init's printed import lines never contain a children
  // expression.
  const occurrences = [...withImports.matchAll(CHILDREN_EXPRESSION)];
  const last = occurrences[occurrences.length - 1];
  if (last === undefined) {
    throw new Error(`${app.layoutRel} has no "{children}" expression for the printed wrap to replace`);
  }
  const pasted =
    withImports.slice(0, last.index) +
    wrapExpression +
    withImports.slice(last.index + last[0].length);
  await writeFile(filePath, pasted, "utf8");

  return { applied: true, file: app.layoutRel, reason: "pasted the printed VendoRoot import(s) + wrap into the layout" };
}
