/**
 * `createFlowletAgent` — the Flowlet F2 agent runtime built on the Vercel `ai`
 * SDK v6. It implements F1's `FlowletAgent` interface: each `run()` drives the
 * model->tool loop and emits F1's `UIMessage` stream (including our `data-ui`
 * parts), wiring together the toolset, render tool, Composio ingestion, and the
 * guardrail policy.
 *
 * Approvals stay on the SDK's NATIVE human-in-the-loop (`needsApproval` tools +
 * `addToolApprovalResponse`), so F1's `@flowlet/core` and `@flowlet/react`
 * remain untouched. Run identity rides as ai SDK message metadata on the
 * `start` chunk (no custom data-run part).
 *
 * This mirrors `@flowlet/core`'s `stub-agent.ts` for the stream/metadata
 * mechanics; the difference is that the engine assembles a real, policy-wrapped
 * toolset from multiple sources instead of a single scripted tool.
 */

import {
  convertToModelMessages,
  createUIMessageStream,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ToolSet,
  type UIMessageChunk,
} from "ai";
import type { FlowletAgent, RunInput, FlowletUIMessage } from "@flowlet/core";
import { SCHEMA_VERSION } from "@flowlet/core";
import { buildToolset, type ToolSourceInput } from "./toolset";
import { createRenderTool } from "./render-tool";
import {
  ingestComposioTools,
  createComposioClient,
  type ComposioClient,
  type ComposioConfig,
} from "./composio";
import type { ApprovalPolicy, ApprovalDecision } from "./policy";
import type { FlowletPrincipal } from "./principal";
import type { ToolDescriptor } from "./descriptor";

/** Canonical name of the engine's built-in UI render tool. */
export const RENDER_TOOL_NAME = "render_ui";

/** Grounded default system prompt used when the caller supplies none. */
const DEFAULT_INSTRUCTIONS =
  "You are a Flowlet agent. Help the user by calling the available tools and, " +
  "when it helps, rendering UI components via the render_ui tool. Only act " +
  "within the user's request; do not take destructive actions without approval.";

/** Configuration for {@link createFlowletAgent}. */
export interface FlowletAgentConfig {
  /** The language model that drives the loop. */
  model: LanguageModel;
  /** The composed guardrail policy applied to every tool. */
  policy: ApprovalPolicy;
  /** Default system prompt; a grounded default is used when omitted. */
  instructions?: string;
  /** The engine's own in-process tools (the render tool is always added). */
  tools?: ToolSet;
  /** Optional Composio ingestion. `client` is injectable for tests. */
  composio?: { config: ComposioConfig; client?: ComposioClient };
  /** Policy version mixed into decision-cache keys. */
  policyVersion?: string;
  /** Max model->tool steps before the loop stops. Defaults to 8. */
  maxSteps?: number;
}

/**
 * Build a Flowlet agent. The returned `run(input)` is turn-based: the ai SDK
 * re-invokes it after a tool approval, so each call builds a FRESH toolset and
 * a FRESH per-run decision cache — that cold cache on the approval turn is what
 * preserves the fail-closed guarantee.
 */
export function createFlowletAgent(config: FlowletAgentConfig): FlowletAgent {
  // Stable, deterministic run identity without Math.random/Date.now.
  let runCounter = 0;

  function run(input: RunInput): ReadableStream<UIMessageChunk> {
    const ordinal = ++runCounter;
    const runId = `run-${ordinal}`;
    const threadId = `thread-${ordinal}`;

    return createUIMessageStream<FlowletUIMessage>({
      execute: async ({ writer }) => {
        // 1. Resolve the principal. A missing/empty userId fails Composio closed
        //    (no external tools) — the safe default.
        const candidate = input.principal as FlowletPrincipal | undefined;
        const principal: FlowletPrincipal =
          candidate &&
          typeof candidate.userId === "string" &&
          candidate.userId.length > 0
            ? candidate
            : { userId: "" };

        // 2. Fresh per-run decision cache (never shared across runs).
        const decisionCache = new Map<string, ApprovalDecision>();

        // 3. The render tool, bound to this run's stream writer.
        const renderTool = createRenderTool(writer);

        // 4. Composio ingestion (fail-closed inside ingestComposioTools).
        let composioTools: ToolSet = {};
        let composioDescriptors: Record<string, ToolDescriptor> = {};
        if (config.composio) {
          const client =
            config.composio.client ?? createComposioClient(config.composio.config);
          const ingested = await ingestComposioTools({
            principal,
            config: config.composio.config,
            client,
          });
          composioTools = ingested.toolset;
          composioDescriptors = Object.fromEntries(
            ingested.descriptors.map((d) => [d.name, d]),
          );
        }

        // 5. Sources in precedence order: caller > engine > composio.
        const sources: ToolSourceInput[] = [
          { source: "caller", tools: input.tools },
          {
            source: "engine",
            tools: { ...config.tools, [RENDER_TOOL_NAME]: renderTool },
          },
          { source: "composio", tools: composioTools, descriptors: composioDescriptors },
        ];

        // 6. Merge + uniformly policy-wrap every tool.
        const tools = buildToolset({
          sources,
          policy: config.policy,
          principal,
          decisionCache,
          policyVersion: config.policyVersion,
        });

        // 7. Drive the model->tool loop.
        const result = streamText({
          model: config.model,
          system: input.system ?? config.instructions ?? DEFAULT_INSTRUCTIONS,
          tools,
          messages: await convertToModelMessages(input.messages),
          abortSignal: input.signal,
          stopWhen: stepCountIs(config.maxSteps ?? 8),
        });

        // 8. Merge the ai SDK UIMessage stream; attach run identity as metadata
        //    on the `start` chunk (replacing the old custom data-run part).
        writer.merge(
          result.toUIMessageStream({
            messageMetadata: ({ part }) =>
              part.type === "start"
                ? { runId, threadId, schemaVersion: SCHEMA_VERSION }
                : undefined,
          }),
        );
      },
    });
  }

  return { run };
}
