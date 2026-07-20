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
  if (!original.includes("{children}")) {
    throw new Error(`${app.layoutRel} has no "{children}" expression for the printed wrap to replace`);
  }

  const importLines = block
    .map((line) => line.trim())
    .filter((line) => line.startsWith("import "));
  const wrapExpression = (wrapMatch[1] ?? "").trim();

  const withImports = importLines.length === 0 ? original : `${importLines.join("\n")}\n${original}`;
  // Replace the LAST "{children}" occurrence, not the first: a spaceless
  // destructure param — `function RootLayout({children}: ...)` — puts a
  // "{children}" in the signature ahead of the JSX one we actually want to
  // wrap (corpus-triage review finding #2).
  const lastIndex = withImports.lastIndexOf("{children}");
  const pasted =
    lastIndex === -1
      ? withImports
      : withImports.slice(0, lastIndex) +
        wrapExpression +
        withImports.slice(lastIndex + "{children}".length);
  await writeFile(filePath, pasted, "utf8");

  return { applied: true, file: app.layoutRel, reason: "pasted the printed VendoRoot import(s) + wrap into the layout" };
}
