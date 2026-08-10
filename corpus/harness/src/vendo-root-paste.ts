import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { findAppRouter } from "./layers/structural.js";

export interface VendoRootPasteResult {
  applied: boolean;
  file: string | null;
  reason: string;
}

const IMPORT_LINE = 'import { VendoProvider } from "@vendoai/vendo/react";';
// Theme-less on purpose: a `import theme from "../vendo/theme"` line would make
// every corpus host's tsconfig need resolveJsonModule. Layer 2 scores the theme
// from .vendo/theme.json on disk, never from the mount.
const WRAP_EXPRESSION = '<VendoProvider baseUrl="/api/vendo">{children}</VendoProvider>';
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

/** Deliberately dumb string surgery: init dropped its layout codemod (see
 * f2c23568) and only prints a paste, so the corpus harness plays the human and
 * pastes the documented canonical mount — docs-site/quickstart.mdx, "The client
 * mount". It does NOT mirror init's printed block: init's copy is init's own
 * contract (packages/vendo/tests/cli/init.test.ts owns it), and wording changes
 * there must never fail the corpus. A green corpus run still means the app is
 * wired end to end, not just that init exited 0. This is not a codemod — the
 * only thing it resolves is the app-router path the harness already needs for
 * the files.expected check (see layers/structural.ts's findAppRouter). */
export async function applyVendoRootPaste(
  repoDir: string,
  framework: "next" | "express" | undefined,
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
  if (original.includes("<VendoProvider")) {
    return { applied: false, file: app.layoutRel, reason: "layout already wraps <VendoProvider> — left unchanged" };
  }

  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const prologueEnd = directivePrologueEnd(lines);
  const withImport = [...lines.slice(0, prologueEnd), IMPORT_LINE, ...lines.slice(prologueEnd)].join(eol);

  // Replace the LAST children occurrence, not the first: a destructure
  // param — `function RootLayout({children}: ...)` — puts a "{children}"
  // in the signature ahead of the JSX one we actually want to wrap
  // (corpus-triage review finding #2).
  const occurrences = [...withImport.matchAll(CHILDREN_EXPRESSION)];
  const last = occurrences[occurrences.length - 1];
  if (last === undefined) {
    throw new Error(`${app.layoutRel} has no "{children}" expression for the mount to wrap`);
  }
  const pasted =
    withImport.slice(0, last.index) +
    WRAP_EXPRESSION +
    withImport.slice(last.index + last[0].length);
  await writeFile(filePath, pasted, "utf8");

  return { applied: true, file: app.layoutRel, reason: "pasted the VendoProvider import + wrap into the layout" };
}
