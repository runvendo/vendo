/**
 * @vendoai/kit — the code-land runtime (blueprint §5.4).
 *
 * What a generated app imports inside its own box. Every export here is a
 * re-export or a thin wrapper over machinery that already ships: there is no
 * second Kit, no second `sum`, no second query path, no second action door.
 *
 * The Kit itself — all 31 components, their prop types, `KIT_COMPONENTS`,
 * `KIT_SPECS`, the semantics tokens and `fmt` — is `@vendoai/ui/kit` verbatim.
 * A generated app and a `.vendo` screen therefore render the same components
 * with the same formatters.
 */

export * from "@vendoai/ui/kit";

/**
 * The TOTAL forms, re-exported from core so an app that wants the REASON a
 * value did not fit can read it. Every wrapper below answers with the value or
 * `undefined`; these two answer with `{ ok, reason }` / `{ ok, issue }`. Same
 * functions, one implementation — this is the second shape, and the only one.
 */
export { applyReshape, evaluateExpr } from "@vendoai/core";
export type {
  Json,
  ReshapeOp,
  ReshapeResult,
  ReshapeStep,
  ToolOutcome,
} from "@vendoai/core";

// The projection vocabulary: nine live reshape ops.
export { reshape } from "./reshape.js";

// The aggregates — core's `$expr` engine, one wrapper per EXPR_CALLS member.
export {
  average,
  count,
  daysUntil,
  difference,
  groupBy,
  max,
  min,
  sum,
  type GroupByAggregate,
  type GroupByBucket,
  type GroupedPoint,
} from "./aggregates.js";

// The one provider, and the app address it derives from the served URL.
export {
  appAddressFromPath,
  useVendoApp,
  VendoAppProvider,
  type QueryRefetch,
  type VendoAppContextValue,
  type VendoAppProviderProps,
} from "./app-context.js";

// The guarded read, the write, and the `$state` binding.
export { useToolQuery, type ToolQuery } from "./query.js";
export { useToolAction, type ToolAction } from "./action.js";
export { useVendoState } from "./state.js";
