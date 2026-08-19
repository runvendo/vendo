/** @vendoai/core — the shapes everything speaks. */
export * from "./agent-context.js";
export * from "./app-access.js";
// The app document's SHAPES (§9). The VALIDATOR half lives on the app-generation
// contract door — it reaches validateTree — but the shape stays here because
// core's own store conformance kit parses a stored app row with it.
export * from "./app-document.js";
export * from "./automation.js";
export * from "./app-surfaces.js";
export * from "./audit.js";
export * from "./capability-miss.js";
// The key-authed console client plumbing every Cloud adapter shares — the
// deployment-identity headers, the wire-legal error table, and the sender.
// `keepAliveFetch` deliberately stays in @vendoai/vendo: it reaches undici, and
// core is bundled for browser and edge targets (portability-gate.mjs).
export * from "./cloud-console.js";
export * from "./cloud-standing.js";
export * from "./define-tool.js";
export * from "./deployment-identity.js";
export * from "./descriptor-hash.js";
export * from "./errors.js";
export * from "./files-wire.js";
export * from "./formats.js";
export * from "./box-ports.js";
export * from "./grants.js";
export * from "./grant-sets.js";
export * from "./guard.js";
export * from "./fetch.js";
export * from "./heartbeat.js";
export * from "./host-seams.js";
export * from "./ids.js";
export * from "./jcs.js";
export * from "./knowledge.js";
export * from "./knowledge-wire.js";
export * from "./limits.js";
export * from "./log.js";
export * from "./meter-exhausted.js";
export * from "./model-seats.js";
export * from "./capability.js";
export * from "./parked-outcome.js";
export * from "./principal.js";
export * from "./reshape.js";
export * from "./product-slug.js";
export * from "./prompt-blocks.js";
export * from "./run-context.js";
export * from "./sdk-events.js";
export * from "./semantics.js";
export * from "./shape.js";
export * from "./sha256.js";
export * from "./skills.js";
export * from "./slot-limits.js";
export * from "./sse-keepalive.js";
export * from "./store.js";
export * from "./thread-window.js";
export * from "./store-wire.js";
export * from "./style.js";
export * from "./engine-collections.js";
export * from "./engine-over-adapter.js";
export * from "./stream-parts.js";
export * from "./tool-envelopes.js";
export * from "./tools.js";
export * from "./turn-result.js";
export * from "./url.js";
export * from "./version.js";
export * from "./genui/tree-node.js";
export * from "./filesystem.js";
export * from "./triggers.js";
export * from "./workspace.js";

// The harness contract plus the two seams it is typed against: the workspace
// filesystem and the model seats. Type-only by design — `defineHarness` and the
// runtime live in @vendoai/harnesses, so core stays the shapes every block may
// speak.
export type {
  BeatPhase,
  DeniedNeeds,
  Harness,
  HarnessEvent,
  SkillListing,
  ToolListing,
  ToolResult,
  Turn,
  TurnSkills,
  TurnState,
  TurnTools,
} from "./harness.js";
export type { CommitResult, WorkspaceFs } from "./workspace.js";
export { WORKSPACE_INLINE_MAX_BYTES, appRootPath } from "./workspace.js";
export type { AppMount } from "./workspace.js";
