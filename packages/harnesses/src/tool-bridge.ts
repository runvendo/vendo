import {
  VENDO_APP_BUILD_FAILED_PREFIX,
  VENDO_KNOWLEDGE_RESULT_KIND,
  VENDO_MAKE_TOOL,
  VENDO_VIEW_STREAM,
  toVendoWirePart,
  vendoAutomationPartSchema,
  vendoCitationsPartSchema,
  vendoKnowledgeCitationSchema,
  vendoViewStreamId,
  vendoViewPartSchema,
  isVendoAppsTool,
  type ApprovalId,
  type Guard,
  type RiskLabel,
  type RunContext,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
  type VendoApprovalPart,
  type VendoAutomationPart,
  type VendoBuildFailedPart,
  type VendoCitationsPart,
  type VendoConnectPart,
  type VendoViewPart,
  type VendoViewStreamingToolCall,
  type VendoViewStreamUpdate,
} from "@vendoai/core";
import type { UIMessage, UIMessageStreamWriter } from "ai";

type VendoPart = VendoApprovalPart | VendoAutomationPart | VendoBuildFailedPart | VendoCitationsPart | VendoConnectPart | VendoViewPart;

/** 03-agent §2 */
export interface ToolBridgeOptions {
  registry: ToolRegistry;
  ctx: RunContext;
  guard?: Guard;
  writer?: UIMessageStreamWriter<UIMessage>;
  toolOutputCap?: number;
  gate?: (call: ToolCall) => ToolOutcome | undefined;
  onCall?: (call: ToolCall) => (outcome: ToolOutcome) => void;
  /** Discovery-discipline 2026-07-25: a pre-guard short-circuit (the connect
   * gate). A non-undefined outcome means the call cannot run — needsApproval
   * skips the guard entirely (no approval minted; the ask would be answered
   * by a card for a call that can never execute) and the registry's execute,
   * wrapped by the same gate, returns the outcome on the tool channel. */
  preflight?: (call: ToolCall, ctx: RunContext) => Promise<ToolOutcome | undefined>;
  /** Per-TURN set of `<connector>:<toolkit>` keys that already rendered a
   * connect card, so one unconnected service costs the user one card no
   * matter how many of its tools the model called. Omit to disable deduping
   * (the away runner has no card surface). */
  connectCards?: Set<string>;
}

function writePart(
  writer: UIMessageStreamWriter<UIMessage> | undefined,
  part: VendoPart,
  id?: string,
): void {
  if (!writer) return;
  // The ai-SDK UI message stream requires custom data chunks to carry their
  // payload under `data` ({ type: "data-*", data }); the stock client's chunk
  // schema hard-rejects the flat form. Core owns that envelope (AGENT-10).
  writer.write(toVendoWirePart(part, id) as never);
}

/** The flat §16 approval part shared by every consent surface (native
 *  needsApproval, pending-approval outcomes). */
export function approvalPart(
  toolCallId: string,
  risk: RiskLabel,
  approvalId: ApprovalId,
  invalidatedGrant?: VendoApprovalPart["invalidatedGrant"],
): VendoApprovalPart {
  return {
    type: "data-vendo-approval",
    toolCallId,
    risk,
    approvalId,
    ...(invalidatedGrant === undefined ? {} : { invalidatedGrant }),
  };
}

function executionError(): ToolOutcome {
  return {
    status: "error",
    error: {
      code: "execution",
      message: "Tool execution failed.",
    },
  };
}

/** Knowledge K1 — lift a `vendo/knowledge-result@1` ok-output onto the
 * citations part. Returns null when the output is not a knowledge envelope,
 * when the outcome is model-facing only (`not-found`, and read-more results,
 * which carry text but no citations), or when no valid citation survives an
 * answered outcome. `title` falls back to the docId — the part surface
 * requires one. Hits validate INDIVIDUALLY (fail-soft, AI-review finding):
 * one malformed hit from a nonconforming BYO engine drops only itself, never
 * the whole citation surface of an otherwise grounded answer. */
function knowledgeCitationsPart(toolCallId: string, output: unknown): VendoCitationsPart | null {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return null;
  const record = output as Record<string, unknown>;
  if (record.kind !== VENDO_KNOWLEDGE_RESULT_KIND) return null;
  const outcome = record.outcome;
  if (outcome !== "answered" && outcome !== "insufficient-evidence" && outcome !== "unavailable") return null;
  const hits = Array.isArray(record.hits) ? record.hits : [];
  const citations = hits.flatMap((hit) => {
    const entry = (typeof hit === "object" && hit !== null ? hit : {}) as Record<string, unknown>;
    const candidate = { ...entry, title: typeof entry.title === "string" && entry.title !== "" ? entry.title : entry.docId };
    const parsed = vendoKnowledgeCitationSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
  if (outcome === "answered" && citations.length === 0) return null;
  const parsed = vendoCitationsPartSchema.safeParse({
    type: "data-vendo-citations",
    toolCallId,
    citations,
    outcome,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The truncation envelope's keys live in Vendo's reserved `vendo_` namespace, and
 * have to: this envelope replaces an output the host DECLARED a schema for, and the
 * MCP door advertises that declaration to clients that validate every result
 * against it — a host field named `preview` of a different type made its own tool
 * throw on a truncated answer. The door's schema sanitizer drops declared `vendo_*`
 * properties so the namespace cannot collide.
 */
function capOutcome(outcome: ToolOutcome, cap: number | undefined): ToolOutcome {
  if (outcome.status !== "ok" || cap === undefined) return outcome;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(outcome.output);
  } catch {
    return executionError();
  }
  if (serialized === undefined || serialized.length <= cap) return outcome;
  return {
    status: "ok",
    output: {
      vendo_truncated: true,
      vendo_chars: serialized.length,
      vendo_preview: serialized.slice(0, cap),
    },
  };
}

/**
 * Execute ONE guarded call with every shipped rail attached: the view channel
 * (a `vendo_apps_*` tree OpenSurface, plus the VENDO_VIEW_STREAM bridge that
 * streams partial views mid-build), the inline connect card with its per-turn
 * dedupe, the build-failed banner, the knowledge citations part, and
 * `toolOutputCap`.
 *
 * Exported so the harness runtime's `turn.tools.call` runs THIS path rather than
 * a second one. A harness that generates an app has to render, and the
 * commit-gated workspace render seam is additive for file-truth harnesses — not a
 * replacement for this channel. Both coexist.
 */
export async function guardedCall(
  descriptor: ToolDescriptor,
  options: ToolBridgeOptions,
  input: unknown,
  { toolCallId }: { toolCallId: string },
): Promise<ToolOutcome> {
  const call: VendoViewStreamingToolCall = { id: toolCallId, tool: descriptor.name, args: input };
  if (descriptor.name === VENDO_MAKE_TOOL && options.writer !== undefined) {
    Object.defineProperty(call, VENDO_VIEW_STREAM, {
      // The producer names the part; this only decides whether to believe it. One
      // schema per type, so nothing can publish a part shape it did not declare.
      value: (update: VendoViewStreamUpdate) => {
        const schema = update.part.type === "data-vendo-view"
          ? vendoViewPartSchema
          : vendoAutomationPartSchema;
        const part = schema.safeParse(update.part);
        if (part.success) writePart(options.writer, part.data, update.id);
      },
    });
  }
  const finishCall = options.onCall?.(call);
  let outcome = options.gate?.(call);
  if (outcome === undefined) {
    try {
      outcome = await options.registry.execute(call, options.ctx);
    } catch {
      outcome = executionError();
    }
  }

  // A view part is emitted ONLY from the app runtime's own view-producing
  // tools returning a tree OpenSurface (06 §1) — never by duck-typing an
  // arbitrary host tool's output, which could otherwise smuggle an unrelated
  // result onto the app-view channel and mis-route its actions (01 §16).
  const producesView = isVendoAppsTool(descriptor.name);
  if (outcome.status === "ok" && producesView) {
    const surface = typeof outcome.output === "object" && outcome.output !== null
      ? outcome.output as Record<string, unknown>
      : undefined;
    const args = typeof input === "object" && input !== null
      ? input as Record<string, unknown>
      : undefined;
    const candidate = surface?.kind === "tree" && surface.payload !== undefined
      ? {
          type: "data-vendo-view",
          // OpenSurface carries no app id (06 §1); the open call's own appId
          // argument identifies the app this payload belongs to.
          appId: surface.appId ?? args?.appId,
          payload: surface.payload,
        }
      : null;
    const view = vendoViewPartSchema.safeParse(candidate);
    if (view.success) writePart(options.writer, view.data, vendoViewStreamId(view.data.appId));
    // The automation card used to be reconstructed HERE, out of the edit tool's
    // returned document. `vendo_make` returns a receipt — four fields of words —
    // so the card is published by the apps runtime through the stream seam above,
    // by the side that knows it armed something. One less thing read by shape.
  } else if (outcome.status === "pending-approval") {
    writePart(options.writer, approvalPart(toolCallId, descriptor.risk, outcome.approvalId));
  } else if (outcome.status === "connect-required") {
    // The inline connect card (04-actions §3): emitted beside the native
    // tool part exactly like the approval part, keyed by toolCallId.
    // ONE card per service per turn: a step that calls two tools of the
    // same unconnected service (gmail_SEND + gmail_FETCH) would otherwise
    // stack two identical cards for one connect action. The model still
    // receives every connect-required outcome — only the card is deduped.
    const cardKey = `${outcome.connect.connector}:${outcome.connect.toolkit}`;
    if (options.connectCards?.has(cardKey) !== true) {
      options.connectCards?.add(cardKey);
      writePart(options.writer, {
        type: "data-vendo-connect",
        toolCallId,
        connector: outcome.connect.connector,
        toolkit: outcome.connect.toolkit,
        message: outcome.connect.message,
      });
    }
  } else if (
    outcome.status === "error"
    && descriptor.name === VENDO_MAKE_TOOL
    && outcome.error.message.startsWith(VENDO_APP_BUILD_FAILED_PREFIX)
  ) {
    // 0.4.4 cert defect B: a terminally failed BUILD is content the user
    // must see — the error outcome alone is model-visible only (the tray
    // renders nothing for an output-available error result), so the turn
    // ended (or worse, retried minutes-long doomed builds) with no banner
    // and no reason. The message is the runtime's canned classified
    // reason (buildFailureReason) — provider-safe by construction. Scoped
    // to the runtime's build-failed prefix: a cheap create error (input
    // validation, feature-flag refusal) stays the model's to handle.
    writePart(options.writer, {
      type: "data-vendo-build-failed",
      toolCallId,
      reason: outcome.error.message,
    });
  }

  // Knowledge K1 — the FULL citation data reaches the client on its own
  // part, written BEFORE capOutcome can touch the ok-output (mirrors the
  // connect part above: the part is the UI's channel; the capped tool
  // output is the model's).
  if (outcome.status === "ok") {
    const citations = knowledgeCitationsPart(toolCallId, outcome.output);
    if (citations !== null) writePart(options.writer, citations);
  }

  const modelOutcome = capOutcome(outcome, options.toolOutputCap);
  finishCall?.(modelOutcome);
  return modelOutcome;
}

/**
 * The approval PREVIEW: the preflight short-circuit plus `previewCheck`, raising
 * today's `data-vendo-approval` part — `invalidatedGrant` and all — when the guard
 * wants a human.
 *
 * Exported for the same reason as {@link guardedCall}, and it is exactly why
 * `previewCheck` exists: a caller that will make the REAL dispatching call
 * moments later must not charge the write-budget/call-rate breakers twice, nor
 * run the judge twice. The harness runtime previews here, awaits the tap, then
 * executes ONCE.
 */
export async function previewApproval(
  descriptor: ToolDescriptor,
  options: ToolBridgeOptions,
  input: unknown,
  { toolCallId }: { toolCallId: string },
  /** Receives the guard's approval id when the verdict is "ask" (undefined when
   *  the guard itself threw and we fail closed) — a second output beside the
   *  boolean verdict, which is the only thing a caller can wait on. */
  onAsk?: (approvalId: ApprovalId | undefined) => void,
): Promise<boolean> {
  if (options.guard === undefined) return false;
  // Pre-guard short-circuit: a call preflight already rules out (an
  // unconnected service) must not reach the guard — asking would mint
  // an approval for a call that can never run. execute() then returns
  // the same outcome (connect card) through the gate-wrapped registry.
  if (options.preflight !== undefined) {
    try {
      const ruled = await options.preflight(
        { id: toolCallId, tool: descriptor.name, args: input },
        options.ctx,
      );
      if (ruled !== undefined) return false;
    } catch {
      // A broken preflight falls through to the normal guard path.
    }
  }
  try {
    // genqa defect 1 (double-count): this is a PREVIEW — when it answers
    // false, the caller makes the REAL call moments later for the SAME
    // toolCallId, which re-enters the guard through
    // `options.registry.execute` (the guard-bound registry; no unguarded
    // path). `check()` alone would charge the write-budget and call-rate
    // breakers on BOTH passes for one logical call, halving the effective
    // budget. `previewCheck` (feature-detected; falls back to `check()` for a
    // guard that predates it) answers identically but never commits a "run"
    // verdict's spend — only the real call does.
    const call: ToolCall = { id: toolCallId, tool: descriptor.name, args: input };
    const decision = options.guard.previewCheck !== undefined
      ? await options.guard.previewCheck(call, descriptor, options.ctx)
      : await options.guard.check(call, descriptor, options.ctx);
    if (decision.action !== "ask") return false;
    writePart(options.writer, approvalPart(
      toolCallId,
      descriptor.risk,
      decision.approval.id,
      decision.approval.invalidatedGrant,
    ));
    onAsk?.(decision.approval.id);
    return true;
  } catch {
    // A guard that throws is treated as wanting a human — fail closed, exactly
    // as the shipped needsApproval hook does. No approvalId exists to wait on.
    onAsk?.(undefined);
    return true;
  }
}
