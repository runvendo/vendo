/**
 * The screen VM, on a WebAssembly module the host compiled at deploy time.
 *
 * The default engine is the SINGLE-FILE build, where the WebAssembly rides
 * inside the JavaScript as a base64 string and is compiled from those bytes at
 * runtime (contract/genui/component/boot.ts:73-88). workerd does not allow that:
 * a Worker may only instantiate a `WebAssembly.Module` that its own deployment
 * imported. So the edge leg takes the module as an ARGUMENT and wraps the
 * wasmfile variant around it — the platform's import stays the platform's, and
 * this package never touches a `.wasm` file.
 *
 * ONE VARIANT PER ISOLATE, held right here at module scope. `warmScreenEngine`
 * memoizes an engine per variant in an unbounded `Map` with no eviction
 * (boot.ts:68), so a host that built a fresh variant per request would leak a
 * whole QuickJS module every time. A module-level slot makes that unreachable:
 * a deployment has one `.wasm`, so it gets one variant and one engine, whatever
 * a caller does with `edgeToolchain`.
 */
import { newVariant, type CustomizeVariantOptions } from "quickjs-emscripten-core";
import {
  bootScreen,
  flattenTree,
  pressControls,
  ScreenError,
  warmScreenEngine,
  type ScreenBudget,
  type ScreenEngineVariant,
  type ScreenInstance,
} from "../../contract/genui/component/index.js";
import type { ScreenPaintInput, ScreenPaintResult } from "../checking/toolchain.js";

/** The deploy-time module, typed off the dependency: this package compiles
 *  against ES2022 with no DOM, so it has no `WebAssembly` namespace to name. */
export type EdgeWasmModule = NonNullable<CustomizeVariantOptions["wasmModule"]>;

/** What `newVariant` takes and returns here, picked out of the engine's own
 *  parameter type so this file needs no dependency on `@jitl/quickjs-ffi-types`
 *  to name it. */
type SyncVariant = Extract<Awaited<ScreenEngineVariant>, { type: "sync" }>;

let variant: ScreenEngineVariant | undefined;

/** The stock wasmfile variant, rewrapped around the host's module. The specifier
 *  stays a literal for boot.ts's reason — a bundler has to be able to inline it.
 *
 *  The cast is a NodeNext interop wart, nothing more: this package's `.d.ts` is
 *  modelled as CommonJS, so the namespace types as `{ default: <the namespace> }`
 *  where its ESM entry really default-exports the variant. */
const rewrap = async (wasmModule: EdgeWasmModule): Promise<SyncVariant> => {
  const base = await import("@jitl/quickjs-wasmfile-release-sync");
  return newVariant(base.default as unknown as SyncVariant, { wasmModule });
};

/** A PROMISE, and one per module rather than one per call: `warmScreenEngine`
 *  keys its engine memo on this object, so a stable key is what makes the engine
 *  stable too. */
export const edgeVariant = (wasmModule: EdgeWasmModule): ScreenEngineVariant =>
  variant ??= rewrap(wasmModule);

/** A copy of the Node leg's paint (checking/toolchain.ts) down to the sentence,
 *  differing only in which engine is warmed and which budget stops a runaway. */
export const edgePaint = async (
  wasmModule: EdgeWasmModule,
  budget: ScreenBudget,
  input: ScreenPaintInput,
): Promise<ScreenPaintResult> => {
  // Outside the try: the engine failing to start is not a verdict on the
  // screen, and the gauntlet says so in its own sentence.
  await warmScreenEngine(edgeVariant(wasmModule));
  let instance: ScreenInstance | undefined;
  try {
    instance = bootScreen({ ...input, budget });
    const tree = flattenTree(instance.tree());
    const misses = instance.misses();
    return { ok: true, tree, misses, inert: misses.length > 0 ? [] : pressControls(tree, () => bootScreen({ ...input, budget })) };
  } catch (error) {
    return error instanceof ScreenError
      ? { ok: false, kind: error.kind, message: error.message, misses: error.misses }
      : { ok: false, kind: "boot", message: error instanceof Error ? error.message : String(error), misses: [] };
  } finally {
    try { instance?.dispose(); } catch { /* ignore */ }
  }
};
