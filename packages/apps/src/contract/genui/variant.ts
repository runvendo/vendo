/**
 * The QuickJS build every venue boots on, and the WebAssembly it boots from.
 *
 * The engine used to ride the SINGLE-FILE build, where the WebAssembly is a raw
 * binary string inside the JavaScript. That build cannot survive a modern
 * minifier: the WASM bytes contain a backtick, SWC re-quotes the string with
 * backticks, and the chunk it emits opens a template literal whose `\0` bytes
 * are illegal octal escapes — `SyntaxError: Octal escape sequences are not
 * allowed in template strings`, in Turbopack's server, SSR and browser chunks
 * alike, which is every screen refused in a production build (#1496). esbuild
 * quotes it safely, which is why the Vite harness and the workerd gate never
 * caught it.
 *
 * So the bytes travel as a FILE. The wasmfile build's loader is ten kilobytes
 * of ordinary JavaScript that any bundler prints correctly, and `wasmBinary`
 * hands it the module's bytes directly (`#engine/wasm`: read off disk on Node,
 * fetched as a bundler-emitted asset everywhere else) — so nothing has to
 * locate a `.wasm` relative to a chunk that moved.
 *
 * A venue that must supply its own module still can, and workerd must: see
 * ../../server/edge/paint.ts, which wraps the same build around a
 * `WebAssembly.Module` its deployment imported.
 */
import { newVariant } from "quickjs-emscripten-core";
import loadWasm from "#engine/wasm";
import type { ScreenEngineVariant } from "./component/boot.js";

/** What `newVariant` takes and returns here, picked out of the engine's own
 *  parameter type — ../../server/edge/paint.ts names it the same way, and for
 *  the same reason: no dependency on `@jitl/quickjs-ffi-types` to spell it. */
type SyncVariant = Extract<Awaited<ScreenEngineVariant>, { type: "sync" }>;

/** The stock variant, built once per call — `warmScreenEngine` memoizes on the
 *  promise it gets back, so callers hold one, not one each.
 *
 *  The cast is the NodeNext interop wart paint.ts documents: this dependency's
 *  `.d.ts` is modelled as CommonJS, so the namespace types as
 *  `{ default: <the namespace> }` where its ESM entry default-exports the
 *  variant. */
export const stockVariant = async (): Promise<SyncVariant> => {
  const base = await import("@jitl/quickjs-wasmfile-release-sync");
  return newVariant(base.default as unknown as SyncVariant, { wasmBinary: loadWasm });
};
