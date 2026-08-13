/**
 * `@vendoai/apps/edge` — the screen toolchain for a venue that is not Node.
 *
 * Screen checking is three machines behind one slot (checking/toolchain.ts):
 * compile the file, type-check it, and RUN it. The stock implementation reaches
 * all three the way a Node process can — esbuild's native binary,
 * `createRequire("typescript")` plus `ts.sys`, and a QuickJS build that compiles
 * its own WebAssembly at runtime — and every one of those is a thing workerd
 * does not have. This is the same three, done the way a Worker can:
 *
 * - **compile** with sucrase (./transform.ts), pure JavaScript, and — like the
 *   types-only transform the fidelity guards are written against — lowering
 *   nothing.
 * - **type-check** with the real compiler over lib files vendored as string
 *   constants (./typecheck.ts, ./lib-source.ts), so there is no filesystem to
 *   need.
 * - **paint** in the wasmfile variant, over a `WebAssembly.Module` the
 *   DEPLOYMENT imported and handed over (./paint.ts) — the one thing a Worker
 *   cannot produce for itself.
 *
 * ```ts
 * import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm";
 * import { edgeToolchain } from "@vendoai/apps/edge";
 *
 * const toolchain = edgeToolchain({ wasmModule });
 * ```
 *
 * The three dependencies are OPTIONAL PEERS, the shape `./e2b` already uses: a
 * Node host pays for none of them, and the venue that needs them is the one that
 * installs them. Nothing in `@vendoai/apps`'s own entry points reaches this
 * directory, so importing the package does not drag a compiler into the bundle.
 *
 * The budget defaults to {@link opsBudget} rather than the wall clock, because
 * workerd freezes the clock while a screen burns and a deadline handler then
 * truthfully answers "not yet" a million times (contract/genui/component/budget.ts).
 */
import { opsBudget, type ScreenBudget } from "../../contract/genui/component/index.js";
import type { ScreenToolchain } from "../checking/toolchain.js";
import { edgePaint, type EdgeWasmModule } from "./paint.js";
import { edgeTransform } from "./transform.js";
import { edgeTypecheck } from "./typecheck.js";

export interface EdgeToolchainOptions {
  /** The QuickJS WebAssembly, compiled at deploy time — on workerd, an import
   *  of `@jitl/quickjs-wasmfile-release-sync/wasm`. */
  readonly wasmModule: EdgeWasmModule;
  /** What stops a screen that will not stop. Unset counts interrupts. */
  readonly budget?: ScreenBudget;
}

export function edgeToolchain(options: EdgeToolchainOptions): ScreenToolchain {
  const budget = options.budget ?? opsBudget();
  return {
    async transform(source) {
      return edgeTransform(source);
    },
    async typecheck(input) {
      return edgeTypecheck(input);
    },
    async paint(input) {
      return edgePaint(options.wasmModule, budget, input);
    },
  };
}

/** The TypeScript this toolchain type-checks with, and the one ./lib-source.ts
 *  was copied from — the peer range is pinned to it exactly. */
export { EDGE_TYPESCRIPT_VERSION } from "./lib-source.js";
