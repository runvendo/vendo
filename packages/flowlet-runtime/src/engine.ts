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
  AuditLog,
  FlowletAgent,
  Principal,
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
import type { ApprovalPolicy } from "./policy";
import type { FlowletPrincipal } from "./principal";
import { buildDescriptor, type ToolDescriptor } from "./descriptor";
import { createRunPolicyContext } from "./policy/run-context";

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

/** Configuration for {@link createFlowletAgent}. */
export interface FlowletAgentConfig {
  /** The language model that drives the loop. */
  model: LanguageModel;
  /** The composed guardrail policy applied to every tool. */
  policy: ApprovalPolicy;
  /** Default system prompt; a grounded default is used when omitted. */
  instructions?: string;
  /**
   * Host-supplied server-executed tools (a mount's `options.tools`, a demo's
   * `extraTools`). Labeled `source: "engine"` — judged and breaker-gated
   * exactly like any other tool. NEVER exempt from the judge/breakers; do not
   * put steering or automation-authoring tools here (see `controlTools`).
   */
  tools?: ToolSet;
  /**
   * Flowlet's OWN control-plane tools — conversational steering
   * (`always_ask_before`/`stop_asking_about`) and automation authoring tools
   * a mount assembles itself. Merged alongside the engine's built-in
   * `render_view`/`request_connect` under `source: "control"` (ENG-193 PR #40
   * review — item A), the ONLY source the judge/`cautionBreaker`/
   * `volumeBreaker` exempt. A mount must NEVER put a host-supplied business
   * tool here — that reopens the exact mislabeling this field was added to
   * close (host tools riding the control-plane exemption via `config.tools`).
   */
  controlTools?: ToolSet;
  /** Optional Composio ingestion. `client` is injectable for tests. */
  composio?: { config: ComposioConfig; client?: ComposioClient };
  /**
   * Policy version string. Reserved: the ask-once `rememberDecisions` layer
   * that keyed on it is retired in favor of `grantPolicy` (ENG-193 §4.3),
   * which doesn't version-key its suppression. Kept on the public config
   * shape for source compatibility; not consulted by the engine itself.
   */
  policyVersion?: string;
  /** Max model->tool steps before the loop stops. Defaults to 8. */
  maxSteps?: number;
  /**
   * Called once the run's stream settles with the FULL updated message list
   * (ENG-193 §6.2 — persistence for the consent endpoint's "load the thread's
   * messages" step). `threadId` is the same id `run()` resolved for the turn
   * (the caller-supplied `RunInput.threadId`, or the engine's minted fallback
   * when none was supplied) — this hook is fixed once at agent construction,
   * so the threadId is how a host attributes the settled list to the right
   * conversation. Errors thrown here are logged, never surfaced to the model
   * or the client — persistence must not take down a finished run.
   */
  onSettled?: (settled: {
    messages: FlowletUIMessage[];
    threadId: string;
    principal: FlowletPrincipal;
  }) => void | Promise<void>;
  /**
   * F1 component registry (prewired + host). When provided, `render_view`
   * validates `source:"host"` nodes server-side — unknown names and
   * schema-invalid props return correctable tool errors the model can repair
   * before anything streams (ENG-186).
   */
  components?: RegisteredComponent[];
  /**
   * UNUSED by the engine itself since ENG-193 PR #40 review (item G) — kept
   * on the public config shape for source compatibility with existing mounts
   * (mirrors `policyVersion` above). Client-executed tool calls (topology B
   * host tools, ENG-202) that the run's INCOMING messages carry in
   * `output-available` state are now audited by routing them through
   * `policy`'s OWN `onExecuted` (see `auditClientExecutedTools` below) — the
   * SAME composed policy every other tool's execution already flows through
   * — rather than appending to a separately-wired log here. A host's
   * `policy` must itself compose an `auditPolicy` (both `@flowlet/next` and
   * the demo hosts already do) for this trail to appear; passing `audit`
   * here no longer does anything on its own.
   */
  audit?: AuditLog;
  /** UNUSED by the engine itself — see `audit` above. Kept for source
   *  compatibility only. */
  auditPrincipal?: (principal: FlowletPrincipal) => Principal;
}

/** Bound on the client-tool-audit dedupe FIFO (see `auditClientExecutedTools`
 *  below). Sized so a long-lived instance can't realistically evict a live id
 *  and double-count within one process lifetime (PR #40 review). */
const MAX_AUDITED_CLIENT_CALLS = 4096;

/** Structural view of the ai SDK tool-part shape scanned for client-executed
 *  results — mirrors `consent.ts`'s `ApprovalPart`, keyed by `output-available`
 *  instead of `approval-*`. */
interface ClientResultPart {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
}

/** Merge `sources` into a name -> descriptor map WITHOUT policy-wrapping —
 *  mirrors `buildToolset`'s own precedence-and-first-wins resolution, kept
 *  separate so the audit scan never depends on (or is skipped by) a tool
 *  failing to wrap. */
function resolveSourceDescriptors(sources: ToolSourceInput[]): Map<string, ToolDescriptor> {
  const map = new Map<string, ToolDescriptor>();
  for (const { source, tools, descriptors } of sources) {
    for (const [name, t] of Object.entries(tools)) {
      if (map.has(name)) continue;
      map.set(name, descriptors?.[name] ?? buildDescriptor(name, t, source));
    }
  }
  return map;
}

/**
 * Scan `messages` for output-available CLIENT-executed tool parts not yet
 * observed and route each one through `policy.onExecuted` (ENG-193 review
 * follow-up; PR #40 review — item G). `wrapClientTool.needsApproval` is the
 * only server-side chokepoint for these tools — there is no server `execute`
 * for the SDK to call `onExecuted` from — so without this scan a client-tool
 * success never reaches the policy stack's `onExecuted` at all: `auditPolicy`
 * never appends its `tool_execution` event for these, AND `volumeBreaker`
 * never counts them toward its threshold.
 *
 * Routing through `policy.onExecuted` (rather than appending an audit event
 * directly, the old shape) means this ONE call now drives both effects
 * uniformly — no separate, parallel bookkeeping to keep in sync. `seen` is
 * the ONLY dedupe gate: `auditPolicy.onExecuted` itself appends
 * `tool_execution` unconditionally on every call (no toolCallId dedupe of its
 * own — only its ESCALATION append is deduped, see audit-policy.ts), so
 * calling this scan again over the SAME settled history must never re-invoke
 * `onExecuted` for a toolCallId it already processed, or every re-scan would
 * double-append.
 *
 * `seen` both checks and marks — see `alreadyAuditedClientCall`. A failure is
 * swallowed, never thrown into the run — this is a trail/counter, not a gate.
 */
async function auditClientExecutedTools(args: {
  messages: FlowletUIMessage[];
  descriptors: Map<string, ToolDescriptor>;
  policy: ApprovalPolicy;
  principal: FlowletPrincipal;
  threadId?: string;
  seen: (toolCallId: string) => boolean;
}): Promise<void> {
  const { messages, descriptors, policy, principal, threadId, seen } = args;
  for (const message of messages) {
    for (const rawPart of message.parts) {
      const part = rawPart as ClientResultPart;
      if (!part.type.startsWith("tool-") || part.state !== "output-available" || !part.toolCallId) continue;
      const toolName = part.type.slice("tool-".length);
      const descriptor = descriptors.get(toolName);
      if (!descriptor || descriptor.executor !== "client") continue;
      if (seen(part.toolCallId)) continue;
      try {
        await policy.onExecuted?.(
          {
            toolName,
            input: part.input,
            descriptor,
            principal,
            threadId,
            toolCallId: part.toolCallId,
          },
          "allow",
        );
      } catch (err) {
        console.error(`[flowlet] failed to audit client-executed tool "${toolName}":`, err);
      }
    }
  }
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

  // Client-tool audit dedupe (`FlowletAgentConfig.audit`): bounded FIFO of
  // toolCallIds already audited, PER ENGINE INSTANCE — shared across every
  // run() the same agent makes (not reset per turn), so a toolCallId seen on
  // an earlier turn's history is never re-audited on a later one.
  const auditedClientCalls = new Set<string>();
  function alreadyAuditedClientCall(toolCallId: string): boolean {
    if (auditedClientCalls.has(toolCallId)) return true;
    auditedClientCalls.add(toolCallId);
    if (auditedClientCalls.size > MAX_AUDITED_CLIENT_CALLS) {
      const oldest = auditedClientCalls.values().next().value;
      if (oldest !== undefined) auditedClientCalls.delete(oldest);
    }
    return false;
  }

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
          part.type.startsWith("tool-") &&
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

  /** The latest user message's text, for the judge's PolicyContext.request
   *  (ENG-193 §4.2). Absent when there is no user message yet (shouldn't
   *  happen in practice — every turn starts from a user message — but a
   *  missing request degrades to "no signal", never a crash). */
  function latestUserRequest(messages: FlowletUIMessage[]): { text: string; messageId: string } | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== "user") continue;
      const text = message.parts
        .filter((p): p is { type: "text"; text: string } => (p as { type: string }).type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (text.length > 0) return { text, messageId: message.id };
    }
    return undefined;
  }

  function run(input: RunInput): ReadableStream<UIMessageChunk> {
    const ordinal = ++runCounter;
    const runId = `run-${ordinal}`;
    const threadId = input.threadId ?? `thread-${ordinal}`;
    // Hoisted so `onFinish` (a SIBLING of `execute` in the object below, not
    // nested inside it) can read the principal `execute` resolves. Both
    // callbacks close over this one binding; `execute` assigns it before any
    // tool runs, and the stream can't finish before `execute` has started.
    let settledPrincipal: FlowletPrincipal = { userId: "" };

    return createUIMessageStream<FlowletUIMessage>({
      // Verified against ai@6.0.28's handleUIMessageStreamFinish: without this,
      // `originalMessages` defaults to `[]` and onFinish's `messages` would be
      // JUST the new assistant message, not the full thread. Passing the run's
      // input messages here makes onFinish's `messages` the FULL updated list
      // ([...originalMessages, state.message]) — what a Store-backed
      // persistence hook (Task 4/5) actually needs to write.
      originalMessages: input.messages,
      // Route execute failures (bad prompt, provider/Composio errors) into the
      // stream as an error part instead of an unhandled rejection — one crashed
      // run must never take the host process down with it.
      onError: (error) => {
        console.error(`[flowlet] run ${runId} failed:`, error);
        return error instanceof Error ? error.message : "The agent run failed.";
      },
      // ENG-193 §6.2: persistence for the consent endpoint's "load the
      // thread's messages" step. A throwing/rejecting hook is caught here,
      // never surfaced to the model or the client stream. Only registered when
      // the caller supplied `onSettled` — no behavior change when it's omitted.
      onFinish: config.onSettled
        ? ({ messages }) => {
            Promise.resolve(
              config.onSettled!({ messages, threadId, principal: settledPrincipal }),
            ).catch((err) =>
              console.error(`[flowlet] onSettled failed for run ${runId}:`, err),
            );
          }
        : undefined,
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
        settledPrincipal = principal;

        // 1b. One judge-context instance for this ENTIRE run (ENG-193 §4.2) —
        // provenance/counters accumulate across every tool call the run
        // makes, across however many model->tool steps it takes.
        const runPolicyContext = createRunPolicyContext(latestUserRequest(input.messages));

        // 2. The render + connect tools, bound to this run's stream writer.
        const renderViewTool = createRenderViewTool(writer, { components: config.components });
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

        // 4. Sources in precedence order: caller > control > engine > composio.
        //    `control` (steering/authoring + the engine's own render/connect
        //    tools) sits ABOVE `engine` (host-supplied server tools) so a host
        //    tool can never shadow a control-plane name (ENG-193 PR #40 review
        //    — item A: these two buckets must stay SEPARATE — merging a host's
        //    tools into `control` is exactly the mislabeling that let host
        //    tools ride the judge/breaker exemption).
        const sources: ToolSourceInput[] = [
          // Defensive: a non-TS caller may omit `tools` entirely.
          { source: "caller", tools: input.tools ?? {} },
          {
            source: "control",
            tools: {
              ...config.controlTools,
              [RENDER_VIEW_TOOL_NAME]: renderViewTool,
              [REQUEST_CONNECT_TOOL_NAME]: requestConnectTool,
            },
          },
          { source: "engine", tools: config.tools ?? {} },
          { source: "composio", tools: composioTools, descriptors: composioDescriptors },
        ];

        // 4b. ENG-193 review follow-up (queued gap) + PR #40 review (item G):
        // client-executed tool calls the INCOMING history already carries
        // resolved (output-available) never reach `onExecuted` any other way
        // — there is no server `execute` for the SDK to call it from. Routed
        // through `config.policy.onExecuted` (not gated on `config.audit`
        // anymore, unlike the old audit-only shape): this is what lets
        // `auditPolicy` append its `tool_execution` trail AND `volumeBreaker`
        // count these calls toward its threshold, for every host regardless
        // of whether it wires an audit log. `resolveSourceDescriptors` and the
        // dedupe below make this cheap even when nothing in the composed
        // policy consumes `onExecuted`.
        await auditClientExecutedTools({
          messages: input.messages,
          descriptors: resolveSourceDescriptors(sources),
          policy: config.policy,
          principal,
          threadId,
          seen: alreadyAuditedClientCall,
        });

        // 5. Merge + uniformly policy-wrap every tool.
        const tools = buildToolset({
          sources,
          policy: config.policy,
          principal,
          threadId,
          writer,
          runContext: runPolicyContext,
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
        const result = streamText({
          model: config.model,
          system: input.system ?? config.instructions ?? DEFAULT_INSTRUCTIONS,
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
