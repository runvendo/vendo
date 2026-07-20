import type { AgentRunReport, Principal, VendoToolEnvelope } from "@vendoai/core";

/**
 * Existing-agents contract — the public tool-pack surface a BYO agent loop
 * gets from the umbrella's `./ai-sdk` and `./mastra` subpaths. Wave 0 freezes
 * the names and option shapes here (the docs, examples, and both shims build
 * against them); Wave 1 Lane A supplies the implementation behind them.
 * Frozen in `docs/superpowers/specs/2026-07-20-existing-agents-contracts.md`.
 */

/** Every pack tool is namespaced under this prefix to avoid collisions with
 *  the host loop's own tools: a registered host tool `host_x` ships as
 *  `vendo_host_x`; the built-ins below are already prefixed. */
export const VENDO_TOOL_PACK_PREFIX = "vendo_" as const;

/** Generate UI. Returns fast with a `vendo/app-ref@1`; the build streams over
 *  the wire, so the host loop is never blocked on generation. */
export const VENDO_CREATE_APP_TOOL = "vendo_create_app" as const;

/** Whole-task delegation via `agent.asRunner()`; returns `VendoDelegateResult`. */
export const VENDO_DELEGATE_TOOL = "vendo_delegate" as const;

/** Pack filtering, matched against FINAL (namespaced) tool names. The static
 *  Mastra shim accepts exactly this (its principal resolves lazily per call
 *  from the framework's runtime context). */
export interface VendoToolPackFilter {
  include?: string[];
  exclude?: string[];
}

/** What the per-request AI SDK shim accepts: tool execution needs a
 *  principal-scoped RunContext, so the pack is built per request. */
export interface VendoToolPackOptions extends VendoToolPackFilter {
  principal: Principal;
}

/** `vendo_delegate`'s output is plain data (no embed): the run report's
 *  status and summary, plus envelope refs to anything the delegated run
 *  produced — the host renders each ref with `<VendoToolResult>` if it wants. */
export interface VendoDelegateResult {
  status: AgentRunReport["status"];
  summary: string;
  refs: VendoToolEnvelope[];
}
