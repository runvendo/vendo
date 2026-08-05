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
