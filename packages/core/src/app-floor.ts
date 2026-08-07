/**
 * The checks floor, as a port — blueprint §7.
 *
 * The floor's implementation lives in `@vendoai/apps` (`checking/`), because it
 * needs the catalog, the tool shapes and a model. Its one hot-path CALLER is the
 * render seam in `@vendoai/harnesses`, which must not import a pipeline body. So
 * the contract between them lives here, beside {@link Finding} and {@link Check},
 * for the same reason those do: both sides already speak core.
 *
 * Two methods, because the seam does two distinct things with them and one of
 * them is cheap:
 *
 *  - `compile` puts model wire through the PRODUCTION dialect. The seam used to
 *    call `compileWire(content)` with no options at all, so every files-first
 *    paint spoke a different dialect than `conductor.ts` — inline tool references
 *    did not expand (the failure recorded at `apps/generation/wire-options.ts`:
 *    "live 2026-07-23: one recompile that lacked these options failed EVERY app
 *    built on inline references") and `bindingErrors`, "the engine's unshippable
 *    gate", was `[]` unconditionally.
 *  - `check` is the seven deterministic fact checks (plus whatever the host
 *    plugged in). A `block` means the app must not reach a screen. The AI reviewer
 *    is deliberately NOT part of this: it spends a model call, and the seam runs on
 *    every commit. Judgment belongs to `validate`.
 */
import type { AppId } from "./ids.js";
import type { Finding } from "./capability.js";
import type { WireCompileResult } from "./genui/wire/compile.js";

export interface AppFloor {
  /** Compile model wire in the production dialect — the same options every other
   *  compile of model wire in this codebase uses. */
  compile(text: string): Promise<WireCompileResult>;
  /**
   * Everything the floor has to say about this compiled app. A `block` means it
   * must not reach a screen.
   *
   * `appId` is here for the same reason `authoredApp` takes one: the checks read a
   * whole `AppDocument`, and a document has an id.
   */
  check(input: { appId: AppId; compiled: WireCompileResult }): Promise<Finding[]>;
}
