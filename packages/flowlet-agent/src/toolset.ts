/**
 * `buildToolset` — merges tools from multiple sources into a single ToolSet,
 * applying fixed precedence and uniform policy wrapping to every tool.
 *
 * Sources are provided in PRECEDENCE ORDER (earliest = highest precedence).
 * The engine passes them as: caller, engine, composio, mcp.
 *
 * Per-tool behaviour:
 * - Collision (name already claimed): skip + call `onCollision`.
 * - No `execute` (wrapTool throws): skip + call `onSkip`. Fail-closed: an
 *   un-enforceable tool is excluded rather than passed through unguarded.
 * - Normal path: resolve descriptor, wrap, register.
 */

import type { ToolSet } from "ai";
import type { ToolSource, ToolDescriptor } from "./descriptor";
import { buildDescriptor } from "./descriptor";
import { wrapTool } from "./wrap-tool";
import type { ApprovalPolicy } from "./policy";
import type { FlowletPrincipal } from "./principal";

/** A single source of tools provided to `buildToolset`. */
export interface ToolSourceInput {
  /** Where these tools originated — used for merge precedence and provenance. */
  source: ToolSource;
  /** The tools provided by this source. */
  tools: ToolSet;
  /**
   * Pre-built descriptors for tools in this source (e.g. from Composio).
   * When present for a given name, the descriptor is used as-is instead of
   * calling `buildDescriptor`.
   */
  descriptors?: Record<string, ToolDescriptor>;
}

/**
 * Merge tools from multiple sources into one policy-wrapped `ToolSet`.
 *
 * @param sources - Tool sources in precedence order (index 0 = highest).
 * @param policy - The composed guardrail policy applied to every tool.
 * @param principal - Identity on whose behalf the agent acts.
 * @param onCollision - Called when a name is already claimed by an earlier source.
 * @param onSkip - Called when a tool cannot be wrapped (e.g. missing `execute`).
 */
export function buildToolset(args: {
  sources: ToolSourceInput[];
  policy: ApprovalPolicy;
  principal: FlowletPrincipal;
  onCollision?: (name: string, kept: ToolSource, dropped: ToolSource) => void;
  onSkip?: (name: string, source: ToolSource, reason: string) => void;
}): ToolSet {
  const { sources, policy, principal, onCollision, onSkip } = args;

  const result: ToolSet = {};
  // Track which source has already claimed each tool name.
  const claimed = new Map<string, ToolSource>();

  for (const { source, tools, descriptors } of sources) {
    for (const [name, tool] of Object.entries(tools)) {
      // Collision: an earlier (higher-precedence) source already owns this name.
      const claimedBy = claimed.get(name);
      if (claimedBy !== undefined) {
        onCollision?.(name, claimedBy, source);
        continue;
      }

      // Resolve descriptor: use the caller-supplied one when available (Composio
      // provides enriched descriptors), otherwise derive it from the tool object.
      const descriptor = descriptors?.[name] ?? buildDescriptor(name, tool, source);

      // Wrap and register. If wrapTool throws (e.g. tool has no `execute`),
      // catch it, report via onSkip, and leave the tool out — fail-closed.
      try {
        const wrapped = wrapTool({
          name,
          tool,
          descriptor,
          policy,
          principal,
        });
        result[name] = wrapped;
        claimed.set(name, source);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        onSkip?.(name, source, reason);
      }
    }
  }

  return result;
}
