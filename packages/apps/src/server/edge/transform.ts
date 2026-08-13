/**
 * The two forms of one screen, compiled by sucrase.
 *
 * esbuild is a native binary and cannot run in a Worker, so this leg is the one
 * that had to be replaced outright rather than reconfigured. Sucrase is the
 * substitute because it is the same KIND of tool the screen contract already
 * assumes: it erases types and expands JSX and lowers nothing else, which is the
 * "types-only transform" the fidelity guards are written against
 * (checking/component-screen.ts:290-311). A screen that survives both scans is a
 * screen whose meaning does not depend on which one ran.
 *
 * The two forms, and why they differ, are the Node toolchain's own
 * (checking/toolchain.ts:33-56) — CommonJS and the automatic runtime for the VM
 * that hosts `require` and publishes `react/jsx-runtime`, the module form and
 * the classic runtime for the scan that has to see the author's own imports.
 * Only the spelling of the options changed.
 *
 * NO STRICT BANNER, and that is an observation rather than an assumption:
 * sucrase's `imports` transform emits `"use strict";` as the first thing in the
 * file, so the engine form is already strict — the property esbuild needed a
 * banner for. `toolchain-edge.test.ts` pins it, on the same screen that pins the
 * banner on the Node side, so the day sucrase stops emitting it is the day a
 * test says so.
 */
import { transform, type Options } from "sucrase";
import type { ScreenTransform } from "../checking/toolchain.js";

/** What `bootScreen` evaluates. */
const ENGINE: Options = {
  transforms: ["typescript", "jsx", "imports"],
  jsxRuntime: "automatic",
  production: true,
  filePath: "screen.tsx",
};

/** What the scan reads. */
const SCAN: Options = {
  transforms: ["typescript", "jsx"],
  jsxRuntime: "classic",
  production: true,
  filePath: "screen.tsx",
};

/** A throw is a screen that does not compile — the gauntlet's "compile" issue. */
export const edgeTransform = (source: string): ScreenTransform => ({
  engine: transform(source, ENGINE).code,
  scan: transform(source, SCAN).code,
});
