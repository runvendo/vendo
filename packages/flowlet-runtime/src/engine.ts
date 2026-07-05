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
import type {
  AnchorContextBlock,
  FlowletAgent,
  RunInput,
  FlowletUIMessage,
  RegisteredComponent,
} from "@flowlet/core";
import { SCHEMA_VERSION } from "@flowlet/core";
import { buildToolset, type ToolSourceInput } from "./toolset";
import { createRenderViewTool } from "./render-view-tool";
import { createRequestConnectTool } from "./request-connect-tool";
import {
  ingestComposioTools,
  createComposioClient,
  type ComposioClient,
  type ComposioConfig,
} from "./composio";
import {
  ingestMcpTools,
  createMcpToolSource,
  type McpServerConfig,
  type McpToolSource,
} from "./mcp";
import type { ApprovalPolicy } from "./policy";
import type { FlowletPrincipal } from "./principal";
import type { ToolDescriptor } from "./descriptor";

/** Canonical name of the engine's built-in composed-view tool (Tier 2.5). */
export const RENDER_VIEW_TOOL_NAME = "render_view";

/**
 * Canonical name of the engine's host-privileged Connect affordance. Emits a
 * host-rendered Connect card so the user can authorize a toolkit; the OAuth flow
 * needs host-page privileges the sandbox denies, so it can't be a render_view.
 */
export const REQUEST_CONNECT_TOOL_NAME = "request_connect";

/** Grounded default system prompt used when the caller supplies none. */
const DEFAULT_INSTRUCTIONS =
  "You are a Flowlet agent. Help the user by calling the available tools and, " +
  "when it helps, rendering UI components via the render_view tool. Only act " +
  "within the user's request; do not take destructive actions without approval.";

/** Anchor block from the latest user message (FlowletRemix, 2026-07-04 spec). */
function lastUserAnchors(messages: FlowletUIMessage[]): AnchorContextBlock | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user") return message.metadata?.anchors;
  }
  return undefined;
}

/**
 * Render the anchor block as a system-prompt section. The scoped anchor's DOM
 * snapshot is the remix baseline: the model is told to reproduce it, then
 * apply the requested delta — not to invent a view from scratch.
 */
function anchorSection(anchors: AnchorContextBlock): string {
  const lines: string[] = ["## Host page context"];
  const { scoped, ambient } = anchors;
  if (scoped) {
    lines.push(
      `The user opened this conversation from the host element "${scoped.label ?? scoped.anchorId}" (anchor id "${scoped.anchorId}").`,
    );
    if (scoped.context !== undefined) {
      lines.push(`Element data: ${JSON.stringify(scoped.context)}`);
    }
    if (scoped.snapshot) {
      lines.push(
        "Rendered baseline (sanitized DOM snapshot of the element as it looks today):",
        scoped.snapshot,
        "If asked to customize or remix this element, render a view via render_view that " +
          "reproduces this baseline faithfully first, then applies the requested change. " +
          "Put the element data in `data` and bind props with { $path } so the host can " +
          "feed live data into the pinned view.",
        "IMPORTANT: the snapshot's class names come from the HOST's stylesheet, which does " +
          "NOT exist inside the render sandbox — copying them produces unstyled, overlapping " +
          "markup. Treat them only as hints about the intended look, and style generated " +
          "components with inline styles plus the --flowlet-* CSS variables (layout with " +
          "flexbox gaps, explicit font sizes, no absolute positioning unless the baseline " +
          "truly overlaps).",
      );
    }
  }
  if (ambient && ambient.length > 0) {
    lines.push(
      "Other elements visible on the user's current page:",
      ...ambient.map(
        (a) =>
          `- "${a.label ?? a.anchorId}" (anchor id "${a.anchorId}")` +
          (a.context !== undefined ? `: ${JSON.stringify(a.context)}` : ""),
      ),
    );
  }
  return lines.join("\n");
}

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
  /**
   * Optional MCP ingestion (host-declared servers). `source` is injectable
   * for tests. `retryDelayMs` (default 30s) is how long a partial ingestion
   * (some server failed) is served from cache before the next turn re-ingests
   * — immediate retry would let a permanently-down server add a connect
   * timeout to every single turn. `0` retries on the very next turn.
   */
  mcp?: { servers: McpServerConfig[]; source?: McpToolSource; retryDelayMs?: number };
  /**
   * Policy version string. Forwarded to policy layers that key on it (e.g. the
   * ask-once `rememberDecisions` store). Not used by the engine itself.
   */
  policyVersion?: string;
  /** Max model->tool steps before the loop stops. Defaults to 8. */
  maxSteps?: number;
  /**
   * F1 component registry (prewired + host). When provided, `render_view`
   * validates `source:"host"` nodes server-side — unknown names and
   * schema-invalid props return correctable tool errors the model can repair
   * before anything streams (ENG-186).
   */
  components?: RegisteredComponent[];
}

/**
 * Build a Flowlet agent. The returned `run(input)` is turn-based: the ai SDK
 * re-invokes it after a tool approval, so each call builds a FRESH toolset. The
 * fail-closed guarantee comes from `wrapTool.execute` ALWAYS re-evaluating the
 * composed policy (the deterministic layers re-run on every callback), not from
 * a cold per-run cache — so a policy whose state changed during the approval
 * gap is enforced at execute time.
 */
export function createFlowletAgent(config: FlowletAgentConfig): FlowletAgent {
  // Stable, deterministic run identity without Math.random/Date.now.
  let runCounter = 0;

  // Build the Composio client ONCE and reuse it across runs. `fetchTools` takes
  // the `userId` per call, so reuse is safe (no cross-user leak), and
  // `createComposioClient` is lazy (it never connects at construction). The
  // injected-client path stays intact for tests.
  const composioClient: ComposioClient | undefined = config.composio
    ? config.composio.client ?? createComposioClient(config.composio.config)
    : undefined;

  // Cache the ingested Composio toolset PER PRINCIPAL across runs. The Composio
  // schema fetch (Gmail/Slack OAuth + tool listing) is a multi-second network
  // round-trip; without this it re-ran on EVERY turn before `streamText`,
  // stalling the first token (and re-ran again on each tool-loop re-invocation
  // after an approval). A user's allowlisted toolset is stable for the agent's
  // lifetime, so we memoize by userId. We cache the PROMISE so concurrent runs
  // for the same user share one in-flight fetch, and we evict on rejection so a
  // transient failure never permanently disables that user's tools.
  type Ingested = { toolset: ToolSet; descriptors: Record<string, ToolDescriptor> };
  const composioCache = new Map<string, Promise<Ingested>>();

  // MCP tools are HOST-level (declared by the host, shared across users), so
  // one ingestion serves every principal — unlike the per-user Composio cache.
  const mcpSource: McpToolSource | undefined = config.mcp
    ? config.mcp.source ?? createMcpToolSource()
    : undefined;
  let mcpCache: Promise<Ingested> | null = null;

  /**
   * Normalize client-supplied history so a stale turn can't wedge the thread.
   * A tool part stuck at `approval-requested` with no response (the user typed
   * past the approval card) converts to a tool_use with NO tool_result — the
   * provider rejects that request and EVERY later turn of the thread. Treat it
   * as declined: `output-denied` emits a valid approval-response + denied
   * tool-result pair. (Parts stuck at input-* from an aborted stream are
   * handled by `ignoreIncompleteToolCalls` at conversion time.)
   */
  function normalizeHistory(messages: FlowletUIMessage[]): FlowletUIMessage[] {
    return messages.map((message) => {
      if (message.role !== "assistant") return message;
      let changed = false;
      const parts = message.parts.map((rawPart) => {
        const part = rawPart as {
          type: string;
          state?: string;
          approval?: { id: string; approved?: boolean | null; reason?: string };
        };
        if (
          // Static tool parts are "tool-<name>"; dynamic tools (MCP) are
          // "dynamic-tool" with the name in `toolName`. Both can strand an
          // unanswered approval.
          (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
          part.state === "approval-requested" &&
          part.approval != null &&
          part.approval.approved == null
        ) {
          changed = true;
          return {
            ...rawPart,
            state: "output-denied",
            approval: {
              ...part.approval,
              approved: false,
              reason: "Not approved — the user moved on without answering.",
            },
          } as typeof rawPart;
        }
        return rawPart;
      });
      return changed ? { ...message, parts } : message;
    });
  }

  function run(input: RunInput): ReadableStream<UIMessageChunk> {
    const ordinal = ++runCounter;
    const runId = `run-${ordinal}`;
    const threadId = `thread-${ordinal}`;

    return createUIMessageStream<FlowletUIMessage>({
      // Route execute failures (bad prompt, provider/Composio errors) into the
      // stream as an error part instead of an unhandled rejection — one crashed
      // run must never take the host process down with it.
      onError: (error) => {
        console.error(`[flowlet] run ${runId} failed:`, error);
        return error instanceof Error ? error.message : "The agent run failed.";
      },
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

        // 2. The render + connect tools, bound to this run's stream writer.
        //    A FlowletRemix-scoped conversation tags every rendered view as a
        //    remix candidate for its anchor.
        const anchors = lastUserAnchors(input.messages);
        const renderViewTool = createRenderViewTool(writer, {
          components: config.components,
          ...(anchors?.scoped ? { remixAnchorId: anchors.scoped.anchorId } : {}),
        });
        const requestConnectTool = createRequestConnectTool(writer);

        // 3. Composio ingestion (fail-closed inside ingestComposioTools).
        //    Memoized per principal so the schema round-trip blocks only the
        //    FIRST turn for a given user; every subsequent turn resolves the
        //    cached toolset instantly and the first token streams without stall.
        let composioTools: ToolSet = {};
        let composioDescriptors: Record<string, ToolDescriptor> = {};
        if (config.composio && composioClient) {
          const composioConfig = config.composio.config;
          const client = composioClient;
          let ingestion = composioCache.get(principal.userId);
          if (!ingestion) {
            ingestion = ingestComposioTools({
              principal,
              config: composioConfig,
              client,
            })
              .then(
                (ingested): Ingested => ({
                  toolset: ingested.toolset,
                  descriptors: Object.fromEntries(
                    ingested.descriptors.map((d) => [d.name, d]),
                  ),
                }),
              )
              .catch((err) => {
                // Don't cache a failure: a later turn should retry the fetch.
                composioCache.delete(principal.userId);
                throw err;
              });
            composioCache.set(principal.userId, ingestion);
          }
          const ingested = await ingestion;
          composioTools = ingested.toolset;
          composioDescriptors = ingested.descriptors;
        }

        // 3b. MCP ingestion (fail-closed inside ingestMcpTools; per-server
        //     fault tolerance). Cached host-level: the tools/list round-trip
        //     blocks only the first turn. `ingestMcpTools` never rejects —
        //     instead it reports per-server `failures`. A clean ingestion is
        //     cached for the agent's lifetime; a PARTIAL one (some server
        //     failed) is served from cache but scheduled for eviction after
        //     `retryDelayMs`, so failed servers are retried without letting a
        //     permanently-down one add a connect timeout to every turn.
        let mcpTools: ToolSet = {};
        let mcpDescriptors: Record<string, ToolDescriptor> = {};
        if (config.mcp && mcpSource && config.mcp.servers.length > 0) {
          const servers = config.mcp.servers;
          const source = mcpSource;
          const retryDelayMs = config.mcp.retryDelayMs ?? 30_000;
          if (!mcpCache) {
            mcpCache = ingestMcpTools({ servers, source }).then((ingested) => {
              if (ingested.failures.length > 0) {
                if (retryDelayMs <= 0) {
                  mcpCache = null;
                } else {
                  const timer = setTimeout(() => {
                    mcpCache = null;
                  }, retryDelayMs);
                  // Never keep the host process alive just for a retry timer.
                  (timer as { unref?: () => void }).unref?.();
                }
              }
              return {
                toolset: ingested.toolset,
                descriptors: Object.fromEntries(ingested.descriptors.map((d) => [d.name, d])),
              };
            });
          }
          const ingested = await mcpCache;
          mcpTools = ingested.toolset;
          mcpDescriptors = ingested.descriptors;
        }

        // 4. Sources in precedence order: caller > engine > composio > mcp.
        const sources: ToolSourceInput[] = [
          // Defensive: a non-TS caller may omit `tools` entirely.
          { source: "caller", tools: input.tools ?? {} },
          {
            source: "engine",
            tools: {
              ...config.tools,
              [RENDER_VIEW_TOOL_NAME]: renderViewTool,
              [REQUEST_CONNECT_TOOL_NAME]: requestConnectTool,
            },
          },
          { source: "composio", tools: composioTools, descriptors: composioDescriptors },
          { source: "mcp", tools: mcpTools, descriptors: mcpDescriptors },
        ];

        // 5. Merge + uniformly policy-wrap every tool.
        const tools = buildToolset({
          sources,
          policy: config.policy,
          principal,
          // Surface dropped tools rather than discarding them silently.
          onCollision: (name, kept, dropped) =>
            console.warn(
              `[flowlet] tool "${name}" from source "${dropped}" dropped: ` +
                `name already claimed by higher-precedence source "${kept}".`,
            ),
          onSkip: (name, source, reason) =>
            console.warn(
              `[flowlet] tool "${name}" from source "${source}" skipped: ${reason}`,
            ),
        });

        // 6. Drive the model->tool loop.
        const baseSystem = input.system ?? config.instructions ?? DEFAULT_INSTRUCTIONS;
        const result = streamText({
          model: config.model,
          system: anchors ? `${baseSystem}\n\n${anchorSection(anchors)}` : baseSystem,
          tools,
          // `ignoreIncompleteToolCalls` drops tool parts an aborted stream left
          // at input-streaming/input-available — without it they convert to a
          // dangling tool_use the provider rejects on every later turn.
          messages: await convertToModelMessages(normalizeHistory(input.messages), {
            ignoreIncompleteToolCalls: true,
          }),
          abortSignal: input.signal,
          stopWhen: stepCountIs(config.maxSteps ?? 8),
        });

        // 7. Merge the ai SDK UIMessage stream; attach run identity as metadata
        //    on the `start` chunk (replacing the old custom data-run part).
        //    `originalMessages` makes an approval-resume CONTINUE the paused
        //    assistant message (same id) instead of appending a replayed copy —
        //    without it every approve/decline doubles the turn on screen.
        writer.merge(
          result.toUIMessageStream({
            originalMessages: input.messages,
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
