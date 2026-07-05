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

import type { ToolSet, UIMessageStreamWriter } from "ai";
import type { VendoUIMessage } from "@vendoai/core";
import type { ToolSource, ToolDescriptor } from "./descriptor.js";
import { buildDescriptor } from "./descriptor.js";
import { wrapTool, type PausedCallTracker } from "./wrap-tool.js";
import { wrapClientTool } from "./wrap-client-tool.js";
import type { ApprovalPolicy } from "./policy/index.js";
import type { VendoPrincipal } from "./principal.js";
import type { RunPolicyContext } from "./policy/run-context.js";

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
  principal: VendoPrincipal;
  /** Stable per-conversation id threaded into every wrapped tool (ENG-193 §4.3). */
  threadId?: string;
  /** The run's stream writer, threaded into every wrapped tool (ENG-193 §4.5). */
  writer?: UIMessageStreamWriter<VendoUIMessage>;
  /** The run's judge context, threaded into every wrapped tool (ENG-193 §4.2). */
  runContext?: RunPolicyContext;
  /**
   * Review follow-up (wrap-tool.ts item 3): a `PausedCallTracker` shared
   * across every turn of the SAME agent — engine.ts rebuilds this whole
   * toolset (and therefore fresh `wrapTool` closures) on every `run()` call,
   * so tracking whether `needsApproval` paused for a toolCallId must live
   * OUTSIDE any single `buildToolset` call to survive into the LATER turn
   * where `execute` runs. Absent -> each wrapped tool gets its own private
   * per-call tracker (`wrapTool`'s default), which is only correct for
   * single-turn callers (tests).
   */
  pausedCalls?: PausedCallTracker;
  onCollision?: (name: string, kept: ToolSource, dropped: ToolSource) => void;
  onSkip?: (name: string, source: ToolSource, reason: string) => void;
  /** Called once per successfully registered tool, with its resolved
   *  descriptor — feeds the per-run capability summary (spec §7). */
  onRegister?: (descriptor: ToolDescriptor) => void;
}): ToolSet {
  const { sources, policy, principal, threadId, writer, runContext, pausedCalls, onCollision, onSkip, onRegister } = args;

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

      // Wrap and register. Client-executed tools (host-API tools that run in
      // the user's browser, ENG-202) have no `execute` by design and are
      // governed via `needsApproval` only; everything else takes the standard
      // execute-gated wrapper. If wrapping throws (e.g. an unmarked tool has
      // no `execute`), catch it, report via onSkip, and leave the tool out —
      // fail-closed.
      try {
        // Branched (not a shared `wrap` variable) so `pausedCalls` — only
        // meaningful for the server-executed path — isn't forced onto
        // `wrapClientTool`'s narrower args via a union call signature.
        const wrapped =
          descriptor.executor === "client"
            ? wrapClientTool({ name, tool, descriptor, policy, principal, threadId, writer, runContext })
            : wrapTool({ name, tool, descriptor, policy, principal, threadId, writer, runContext, pausedCalls });
        result[name] = wrapped;
        claimed.set(name, source);
        onRegister?.(descriptor);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        onSkip?.(name, source, reason);
      }
    }
  }

  return result;
}
