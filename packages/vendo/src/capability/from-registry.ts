/**
 * Re-express a shipped `ToolRegistry` as tool definitions.
 *
 * This exists so a capability block that already owns a registry can arrive
 * through the public `tools` slot instead of being added to the tool registry by
 * a privileged path. The tools themselves are untouched: the whole
 * call — arguments and anything riding on it, like the app-create view-stream
 * bridge — is handed to the registry exactly as it arrived, and the OUTCOME
 * comes back exactly as the registry authored it.
 *
 * That last part is why {@link BACKING_REGISTRY} exists. A tool definition's own
 * `execute` answers with output or throws, because the denial statuses belong to
 * the guard; squeezing a registry's five-status outcome through that channel
 * flattens `blocked`, `connect-required` and `pending-approval` into errors and
 * rewrites every error code as "validation". Codes reach the model and the audit
 * row, so the merge dispatches straight to the backing registry when this marker
 * is present. `execute` stays implemented as an honest lossy fallback, for any
 * consumer that reads the definition without knowing about the marker.
 */
import {
  VendoError,
  type Json,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";

/**
 * Marks a tool definition whose real implementation is a `ToolRegistry`, so the merge
 * can hand the call over and return its outcome verbatim.
 *
 * A module-private `Symbol()`, deliberately NOT `Symbol.for()` and never
 * exported: a well-known symbol is reproducible by any module that knows the
 * string, which would let a hostile or careless contributor attach it and return a
 * verbatim outcome of its choosing — including a forged `pending-approval` that
 * the BYO approval decorator would park as if the guard had asked for a card.
 * Only this file can mint the marker, so "denials are the guard's" is not a
 * convention a contributor can opt out of.
 */
const BACKING_REGISTRY = Symbol("vendo.backing-tool-registry");

/** The registry behind a tool definition, when there is one. */
export const backingRegistry = (definition: ToolDefinition): (() => ToolRegistry) | undefined =>
  (definition as { [BACKING_REGISTRY]?: () => ToolRegistry })[BACKING_REGISTRY];

const unwrap = (name: string, outcome: ToolOutcome): Json => {
  switch (outcome.status) {
    case "ok":
      return outcome.output;
    case "error":
      throw new VendoError(
        outcome.error.code === "not-found" ? "not-found" : "validation",
        outcome.error.message,
      );
    case "blocked":
      throw new VendoError("blocked", outcome.reason);
    case "connect-required":
      throw new VendoError("validation", outcome.connect.message);
    case "pending-approval":
      throw new VendoError(
        "validation",
        `the tool "${name}" answered with a pending approval, which the guard owns rather than the tool`,
      );
  }
};

/** `registry` is a thunk because the block that owns it is usually composed
 *  after the merge; it is resolved when a tool actually runs. */
export const toolsFromRegistry = (
  registry: () => ToolRegistry,
  descriptors: readonly ToolDescriptor[],
): ToolDefinition[] => descriptors.map((descriptor) => ({
  ...descriptor,
  [BACKING_REGISTRY]: registry,
  execute: async (_input, context, call) => unwrap(descriptor.name, await registry().execute(call, context)),
}));
