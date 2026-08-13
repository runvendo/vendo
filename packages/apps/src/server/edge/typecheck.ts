/**
 * The real TypeScript compiler, with no filesystem under it.
 *
 * `ts.sys` is Node's disk and does not exist on workerd, so the Node leg's
 * `createRequire("typescript")` plus `ts.getDefaultLibFilePath` cannot be
 * followed here: the compiler is IMPORTED (an optional peer, pinned to the
 * version ./lib-source.ts was copied from) and its standard library arrives as
 * string constants. That is the whole difference — the program builder,
 * the diagnostics and the sentences are `screenProgramWith`'s, shared verbatim
 * with the Node leg, because a finding that differed between them would be the
 * one thing this toolchain is not allowed to do.
 *
 * `getDefaultLibFileName` answers a BARE name, and that is load-bearing: the
 * compiler resolves each requested lib against the default lib's own directory,
 * so a bare name keeps every lookup a bare name — exactly the keys the table
 * carries.
 *
 * FAIL CLOSED, LOUDLY. A missing lib file does not stop the compiler; it makes
 * it report that `Promise` and `Array` do not exist, which reads as a screen
 * full of findings, or — worse, for a lib the screen never touches — as a clean
 * one. So the closure is checked BEFORE the program is built and a gap is named:
 * `ok: false` becomes the gauntlet's "typecheck-unavailable" refusal, which is
 * the honest answer for a gate that could not read the screen.
 */
import ts from "typescript";
import { screenProgramWith, type LibTextProvider } from "../checking/screen-program.js";
import { screenTypecheckIssues } from "../checking/screen-typecheck.js";
import type { ScreenTypecheckInput, ScreenTypecheckResult } from "../checking/toolchain.js";
import { EDGE_DEFAULT_LIB, EDGE_LIB_SOURCES } from "./lib-source.js";

/** `/// <reference lib="es2019" />` — how one lib file names another. */
const REFERENCE = /\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/gu;

const libs: LibTextProvider = {
  read: (fileName) => EDGE_LIB_SOURCES[fileName],
  exists: (fileName) => EDGE_LIB_SOURCES[fileName] !== undefined,
};

/** The first lib file in the request's transitive closure that this bundle does
 *  not carry, or `undefined` when the closure is whole. */
const missingLib = (requested: readonly string[]): string | undefined => {
  const pending = [EDGE_DEFAULT_LIB, ...requested];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const text = EDGE_LIB_SOURCES[name];
    if (text === undefined) return name;
    for (const [, lib] of text.matchAll(REFERENCE)) pending.push(`lib.${lib}.d.ts`);
  }
  return undefined;
};

export const edgeTypecheck = ({ source, typings, lib, components }: ScreenTypecheckInput): ScreenTypecheckResult => {
  const missing = missingLib(lib);
  if (missing !== undefined) {
    return { ok: false, why: `the bundled TypeScript standard library does not carry ${JSON.stringify(missing)}` };
  }
  const program = screenProgramWith(ts, { screen: source, typings, lib }, libs, () => EDGE_DEFAULT_LIB);
  if (!program.ok) return program;
  return { ok: true, issues: screenTypecheckIssues(program, components) };
};
