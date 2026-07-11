/**
 * `createVendoAgent` — the Vendo F2 agent runtime built on the Vercel `ai`
 * SDK v6. It implements F1's `VendoAgent` interface: each `run()` drives the
 * model->tool loop and emits F1's `UIMessage` stream (including our `data-ui`
 * parts), wiring together the toolset, render tool, Composio ingestion, and the
 * guardrail policy.
 *
 * Approvals stay on the SDK's NATIVE human-in-the-loop (`needsApproval` tools +
 * `addToolApprovalResponse`), so F1's `@vendoai/core` and `@vendoai/react`
 * remain untouched. Run identity rides as ai SDK message metadata on the
 * `start` chunk (no custom data-run part).
 *
 * This mirrors `@vendoai/core`'s `stub-agent.ts` for the stream/metadata
 * mechanics; the difference is that the engine assembles a real, policy-wrapped
 * toolset from multiple sources instead of a single scripted tool.
 */

import {
  convertToModelMessages,
  createUIMessageStream,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type LanguageModel,
  type ToolSet,
  type UIMessageChunk,
} from "ai";
import { jsonRepairMiddleware } from "./json-repair.js";
import type {
  AuditLog,
  VendoAgent,
  Principal,
  RunInput,
  VendoUIMessage,
  RegisteredComponent,
  ToolSummaryInput,
} from "@vendoai/core";
import { SCHEMA_VERSION } from "@vendoai/core";
import { buildToolset, type ToolSourceInput } from "./toolset.js";
import { createPausedCallTracker } from "./wrap-tool.js";
import { createRenderViewTool } from "./render-view-tool.js";
import { createRequestConnectTool } from "./request-connect-tool.js";
import {
  ingestComposioTools,
  createComposioClient,
  type ComposioClient,
  type ComposioConfig,
} from "./composio.js";
import {
  ingestMcpTools,
  createMcpToolSource,
  type McpServerConfig,
  type McpToolSource,
} from "./mcp.js";
import type { ApprovalDecision, ApprovalPolicy } from "./policy/index.js";
import type { VendoPrincipal } from "./principal.js";
import { buildDescriptor, type ToolDescriptor } from "./descriptor.js";
import { createRunPolicyContext } from "./policy/run-context.js";

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
  "You are a Vendo agent. Help the user by calling the available tools and, " +
  "when it helps, rendering UI components via the render_view tool. Only act " +
  "within the user's request; do not take destructive actions without approval.";

/**
 * Per-run instruction context (context-engineering spec §1/§7): the chat
 * toolset is not known at config time — Composio descriptors resolve inside
 * `run()` — so instruction assembly may run AFTER tool ingestion. `toolSummary`
 * is the merged live toolset in the shared `ToolSummaryInput` shape, ready for
 * `capabilitySummary()`.
 */
export interface InstructionContext {
  toolSummary: ToolSummaryInput[];
}

/** Configuration for {@link createVendoAgent}. */
export interface VendoAgentConfig {
  /** The language model that drives the loop. */
  model: LanguageModel;
  /** The composed guardrail policy applied to every tool. */
  policy: ApprovalPolicy;
  /**
   * Default system prompt; a grounded default is used when omitted. A function
   * is evaluated per run, after tool ingestion, with the live tool summary.
   */
  instructions?: string | ((ctx: InstructionContext) => string);
  /**
   * Host-supplied server-executed tools (a mount's `options.tools`, a demo's
   * `extraTools`). Labeled `source: "engine"` — judged and breaker-gated
   * exactly like any other tool. NEVER exempt from the judge/breakers; do not
   * put steering or automation-authoring tools here (see `controlTools`).
   */
  tools?: ToolSet;
  /**
   * Vendo's OWN control-plane tools — conversational steering
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
   * Optional MCP ingestion (host-declared servers). `source` is injectable
   * for tests. `retryDelayMs` (default 30s) is how long a partial ingestion
   * (some server failed) is served from cache before the next turn re-ingests
   * — immediate retry would let a permanently-down server add a connect
   * timeout to every single turn. `0` retries on the very next turn.
   */
  mcp?: { servers: McpServerConfig[]; source?: McpToolSource; retryDelayMs?: number };
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
    messages: VendoUIMessage[];
    threadId: string;
    principal: VendoPrincipal;
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
   * `policy` must itself compose an `auditPolicy` (both `vendo/server` and
   * the demo hosts already do) for this trail to appear; passing `audit`
   * here no longer does anything on its own.
   */
  audit?: AuditLog;
  /** UNUSED by the engine itself — see `audit` above. Kept for source
   *  compatibility only. */
  auditPrincipal?: (principal: VendoPrincipal) => Principal;
}

/** Bound on the client-tool-audit dedupe FIFO (see `auditClientExecutedTools`
 *  below). Sized so a long-lived instance can't realistically evict a live id
 *  and double-count within one process lifetime (PR #40 review). */
const MAX_AUDITED_CLIENT_CALLS = 4096;

/** Structural view of the ai SDK tool-part shape scanned for client-executed
 *  results — mirrors `consent.ts`'s `ApprovalPart`, keyed by `output-available`
 *  instead of `approval-*`. `approval` mirrors the SDK's own
 *  `output-available` part shape (ai@6.0.28's `UIToolInvocation`): present
 *  ONLY when the call actually went through the native approval round-trip,
 *  with `approved: true` (finding 3 — a call the SDK auto-allowed with no
 *  approval request carries no `approval` field at all). */
interface ClientResultPart {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  approval?: { id: string; approved?: boolean; reason?: string };
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
  messages: VendoUIMessage[];
  descriptors: Map<string, ToolDescriptor>;
  policy: ApprovalPolicy;
  principal: VendoPrincipal;
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
      // Finding 3: derive the decision from the part itself rather than
      // hardcoding "allow" — a human-APPROVED client call (the part carries
      // `approval.approved === true` because it went through the SDK's
      // native approval round-trip) must report "approve", or it never counts
      // as a clean human approval for `cautionBreaker`'s `onExecuted` lift
      // (breakers.ts only increments `cleanApprovals` on `decision ===
      // "approve"`). A call the SDK auto-allowed (no `approval` field at all)
      // correctly stays "allow".
      const decision: ApprovalDecision = part.approval?.approved === true ? "approve" : "allow";
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
          decision,
        );
      } catch (err) {
        console.error(`[vendo] failed to audit client-executed tool "${toolName}":`, err);
      }
    }
  }
}

/**
 * Build a Vendo agent. The returned `run(input)` is turn-based: the ai SDK
 * re-invokes it after a tool approval, so each call builds a FRESH toolset. The
 * fail-closed guarantee comes from `wrapTool.execute` ALWAYS re-evaluating the
 * composed policy (the deterministic layers re-run on every callback), not from
 * a cold per-run cache — so a policy whose state changed during the approval
 * gap is enforced at execute time.
 */
export function createVendoAgent(config: VendoAgentConfig): VendoAgent {
  // Stable, deterministic run identity without Math.random/Date.now.
  let runCounter = 0;

  // Engine-owned JSON repair: streamed
  // tool inputs whose JSON broke on raw control chars are repaired before the
  // ai SDK gives up on them, and historical broken inputs are repaired (or
  // emptied) before they can 400 a later turn at the provider.
  const model = wrapLanguageModel({
    model: config.model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: jsonRepairMiddleware,
  });

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

  // Client-tool audit dedupe (`VendoAgentConfig.audit`): bounded FIFO of
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

  // Review follow-up (wrap-tool.ts item 3): PER ENGINE INSTANCE, same
  // survives-across-turns reasoning as `auditedClientCalls` above —
  // `needsApproval` (this turn) and `execute` (a LATER turn, after the
  // toolset below is rebuilt from scratch) must share ONE tracker or
  // `wrapTool`'s fail-closed escalation check would see every approved resume
  // as an unrecorded pause and wrongly refuse to run it.
  const pausedCalls = createPausedCallTracker();

  // MCP tools are HOST-level (declared by the host, shared across users), so
  // one ingestion serves every principal — unlike the per-user Composio cache.
  const mcpSource: McpToolSource | undefined = config.mcp
    ? config.mcp.source ?? createMcpToolSource()
    : undefined;
  let mcpCache: Promise<Ingested> | null = null;

  /**
   * The model-visible text for an explicit decline. The shell answers an
   * approval card with `{ approved: false }` and NO reason, and the ai SDK
   * converts a reason-less `output-denied` part into the bare error
   * "Tool execution denied." — which reads as retryable, so the model
   * re-pitches the very action the user just refused. Stamping the reason
   * here (serialization layer only — the approval state machine is untouched)
   * makes the decline an unambiguous user decision with the behavioral rule
   * attached.
   */
  function declineReason(toolName: string): string {
    return (
      `The user DECLINED the "${toolName}" action on the approval card. ` +
      "This is the user's explicit decision, not an error: acknowledge the " +
      "refusal briefly, leave the action undone, and do not re-propose or " +
      "retry it unless the user asks for it again."
    );
  }

  /** Static tool parts are "tool-<name>"; dynamic (MCP) parts are
   *  "dynamic-tool" with the name in `toolName`. */
  function partToolName(rawPart: unknown, type: string): string {
    if (type === "dynamic-tool") {
      const name = (rawPart as { toolName?: unknown }).toolName;
      return typeof name === "string" && name.length > 0 ? name : "requested";
    }
    return type.slice("tool-".length);
  }

  /**
   * Normalize client-supplied history so a stale turn can't wedge the thread.
   * A tool part stuck at `approval-requested` with no response (the user typed
   * past the approval card) converts to a tool_use with NO tool_result — the
   * provider rejects that request and EVERY later turn of the thread. Treat it
   * as declined: `output-denied` emits a valid approval-response + denied
   * tool-result pair. (Parts stuck at input-* from an aborted stream are
   * handled by `ignoreIncompleteToolCalls` at conversion time.)
   *
   * Explicitly DECLINED parts (`output-denied`, `approved: false`) that carry
   * no reason get `declineReason` stamped so the model sees the user's
   * decision instead of a bare tool error; an existing reason always wins.
   */
  function normalizeHistory(messages: VendoUIMessage[]): VendoUIMessage[] {
    return messages.map((message) => {
      if (message.role !== "assistant") return message;
      let changed = false;
      const parts = message.parts.map((rawPart) => {
        const part = rawPart as {
          type: string;
          state?: string;
          input?: unknown;
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
        // An explicit decline with no reason: make the user's decision visible
        // to the model (see declineReason above). A part that already carries
        // a reason — including the stranded-approval text stamped by the
        // branch above on an earlier turn — is left alone.
        // Two shapes carry an explicit decline: `output-denied` (already
        // settled) and `approval-responded` with approved:false — the LIVE
        // path, where the react layer auto-resubmits right after the card is
        // answered and the SDK's resume synthesizes the execution-denied
        // result from THIS part's approval.reason.
        if (
          (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
          (part.state === "output-denied" || part.state === "approval-responded") &&
          part.approval != null &&
          part.approval.approved === false &&
          (part.approval.reason == null || part.approval.reason.trim() === "")
        ) {
          changed = true;
          return {
            ...rawPart,
            approval: {
              ...part.approval,
              reason: declineReason(partToolName(rawPart, part.type)),
            },
          } as typeof rawPart;
        }
        // A tool call whose streamed input JSON broke lands in history with a
        // non-object `input`. jsonRepairMiddleware (transformParams) repairs
        // or empties it at the provider boundary — repairable history keeps
        // its data instead of the old blanket `{}` coercion here.
        return rawPart;
      });
      return changed ? { ...message, parts } : message;
    });
  }

  /** The latest user message's text, for the judge's PolicyContext.request
   *  (ENG-193 §4.2). Absent when there is no user message yet (shouldn't
   *  happen in practice — every turn starts from a user message — but a
   *  missing request degrades to "no signal", never a crash). */
  function latestUserRequest(messages: VendoUIMessage[]): { text: string; messageId: string } | undefined {
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
    let settledPrincipal: VendoPrincipal = { userId: "" };

    // Route run/step failures (bad prompt, provider/Composio errors) into the
    // stream as an error part instead of an unhandled rejection — one crashed
    // run must never take the host process down with it. Serialization
    // boundary: the raw message (provider 401s carrying key prefixes,
    // Composio/network detail) must not reach the client stream — sanitized
    // HERE, not at throw sites, so error classification (telemetry's
    // errorClassName, policy retry paths) still sees the original error.
    // Wired into BOTH `createUIMessageStream` (execute/merge failures) and
    // `toUIMessageStream` below (streamText failures, whose own onError
    // defaults to the raw getErrorMessage).
    const streamError = (error: unknown): string => {
      console.error(`[vendo] run ${runId} failed:`, error);
      return "something went wrong running this step — check the server logs";
    };

    return createUIMessageStream<VendoUIMessage>({
      // Verified against ai@6.0.28's handleUIMessageStreamFinish: without this,
      // `originalMessages` defaults to `[]` and onFinish's `messages` would be
      // JUST the new assistant message, not the full thread. Passing the run's
      // input messages here makes onFinish's `messages` the FULL updated list
      // ([...originalMessages, state.message]) — what a Store-backed
      // persistence hook (Task 4/5) actually needs to write.
      originalMessages: input.messages,
      onError: streamError,
      // ENG-193 §6.2: persistence for the consent endpoint's "load the
      // thread's messages" step. A throwing/rejecting hook is caught here,
      // never surfaced to the model or the client stream. Only registered when
      // the caller supplied `onSettled` — no behavior change when it's omitted.
      onFinish: config.onSettled
        ? ({ messages }) => {
            Promise.resolve(
              config.onSettled!({ messages, threadId, principal: settledPrincipal }),
            ).catch((err) =>
              console.error(`[vendo] onSettled failed for run ${runId}:`, err),
            );
          }
        : undefined,
      execute: async ({ writer }) => {
        // 1. Resolve the principal. A missing/empty userId fails Composio closed
        //    (no external tools) — the safe default.
        const candidate = input.principal as VendoPrincipal | undefined;
        const principal: VendoPrincipal =
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
        const renderViewTool = createRenderViewTool(writer, {
          components: config.components,
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

        // 4. Sources in precedence order: caller > control > engine >
        //    composio > mcp. `control` (steering/authoring + the engine's own
        //    render/connect tools) sits ABOVE `engine` (host-supplied server
        //    tools) so a host tool can never shadow a control-plane name
        //    (ENG-193 PR #40 review — item A: these two buckets must stay
        //    SEPARATE — merging a host's tools into `control` is exactly the
        //    mislabeling that let host tools ride the judge/breaker exemption).
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
          { source: "mcp", tools: mcpTools, descriptors: mcpDescriptors },
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
        const registered: ToolDescriptor[] = [];
        const tools = buildToolset({
          sources,
          policy: config.policy,
          principal,
          threadId,
          writer,
          runContext: runPolicyContext,
          pausedCalls,
          // Surface dropped tools rather than discarding them silently.
          onCollision: (name, kept, dropped) =>
            console.warn(
              `[vendo] tool "${name}" from source "${dropped}" dropped: ` +
                `name already claimed by higher-precedence source "${kept}".`,
            ),
          onSkip: (name, source, reason) =>
            console.warn(
              `[vendo] tool "${name}" from source "${source}" skipped: ${reason}`,
            ),
          onRegister: (descriptor) => registered.push(descriptor),
        });

        // 5b. Per-run instruction assembly (spec §1/§7): a function gets the
        // LIVE merged toolset — the only place it is actually known.
        const instructions =
          typeof config.instructions === "function"
            ? config.instructions({ toolSummary: toToolSummary(registered) })
            : config.instructions;

        // 6. Drive the model->tool loop. `instructions` is the PER-RUN
        // evaluated prompt (function form resolved above, spec §1).
        const baseSystem = input.system ?? instructions ?? DEFAULT_INSTRUCTIONS;
        const result = streamText({
          model,
          system: baseSystem,
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
            // Without this, toUIMessageStream's own default (getErrorMessage)
            // serializes the RAW streamText failure into the error chunk —
            // the outer createUIMessageStream onError never sees it because
            // the merged stream doesn't reject, it carries an error chunk.
            onError: streamError,
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

/** Map registered descriptors to the shared capability-summary contract.
 *  Engine-internal protocol tools are mechanics, not capabilities. */
function toToolSummary(descriptors: ToolDescriptor[]): ToolSummaryInput[] {
  return descriptors
    .filter(
      (d) => d.name !== RENDER_VIEW_TOOL_NAME && d.name !== REQUEST_CONNECT_TOOL_NAME,
    )
    .map((d) => ({
      name: d.name,
      description: d.description,
      tier: d.annotations.readOnlyHint
        ? ("read" as const)
        : d.annotations.destructiveHint
          ? ("critical" as const)
          : ("act" as const),
      source:
        d.source === "composio" || d.source === "mcp"
          ? ("integration" as const)
          : ("host" as const),
      toolkit: d.toolkit,
    }));
}
