/**
 * The checks floor, as a port — blueprint §7.
 *
 * The floor's implementation lives in the server half (`server/checking/`),
 * because it needs the catalog, the tool shapes and a model. Its one hot-path
 * CALLER is the render seam, which must not import a pipeline body. So the
 * contract between them lives here on the browser-safe contract door, beside
 * {@link Finding} and {@link Check}, for the same reason those do: both sides
 * already speak the contract.
 *
 * Two methods, because the seam does two distinct things with them and one of
 * them is cheap:
 *
 *  - `compile` puts model wire through the PRODUCTION dialect. The seam used to
 *    call `compileWire(content)` with no options at all, so every files-first
 *    paint spoke a different dialect than the generation path — inline tool
 *    references did not expand and `bindingErrors`, "the engine's unshippable
 *    gate", was `[]` unconditionally. The incident is recorded once, at
 *    `server/runtime/wire-options.ts`; do not re-tell it here.
 *  - `check` is the seven deterministic fact checks (plus whatever the host
 *    plugged in). A `block` means the app must not reach a screen. The AI reviewer
 *    is deliberately NOT part of this: it spends a model call, and the seam runs on
 *    every commit. Judgment belongs to `validate`.
 */
import {
  type AppDocument,
  type AppId,
  type Finding,
} from "@vendoai/core";
import type { AppPlan } from "./genui/plan/types.js";
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
export interface CheckInput {
  document: AppDocument;
  /** The user's own words — what the app was asked to be. */
  request: string;
  /** The plan the app was built from, when the check runs mid-pipeline; absent
   *  for checks over a finished document. */
  plan?: AppPlan;
}

/**
 * A check on the floor. Two kinds, and the difference is who decides:
 *
 * - `fact` — decidable by looking things up, so it is plain code the floor runs.
 * - `judgment` — a rule only a reader can apply, so it is one sentence that
 *   joins the reviewer's rubric as its own line.
 *
 * `kind` is OPTIONAL on the fact variant and absence means `"fact"`: checks
 * predate this field, and the floor is a safety floor. Anything that is not
 * explicitly a judgment rule is code we run — a check that silently stops
 * firing is the worst failure this contract could allow.
 */
export type Check =
  | { name: string; kind?: "fact"; run(input: CheckInput): Promise<Finding[]> }
  | { name: string; kind: "judgment"; rule: string };

/** Re-exported so the contract door is the one place a consumer reads the
 *  checking vocabulary from, even though the shape itself lives in core (L1). */
export type { Finding };
