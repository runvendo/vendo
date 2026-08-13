import { riskLabelSchema, type RiskLabel, type UIPayload, type VendoAutomationPart, type VendoBuildFailedPart, type VendoConnectPart, type VendoGrantSetPart, type VendoStepLimitPart, type VendoTurnErrorPart, type VendoViewPart } from "@vendoai/core";
import { isToolUIPart, type DynamicToolUIPart, type ToolUIPart, type UIMessage } from "ai";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useVendoProvider } from "../../context.js";
import { useSplitView } from "../split-view.js";
import { useApprovalSheetPresentation } from "../../hooks/use-mobile-takeover.js";
import { PayloadView } from "../../tree/renderer.js";
import { useSlots } from "../../hooks/use-slots.js";
import { AddToPicker } from "../add-to-picker.js";
import { ApprovalCard } from "../approval-card.js";
import { useApprovalModal } from "../approval-modal.js";
import { ApprovalSheet } from "../approval-sheet.js";
import { AutomationCard } from "../automation-card.js";
import { BuildBeat, toolPresentation } from "../build-beat.js";
import { ConnectCard } from "../connect-card.js";
import { GrantSetCard, type GrantSetPermission } from "../grant-set-card.js";
import { toolkitDisplayName, toolTitle } from "../humanize.js";
import { Markdown } from "../markdown.js";
import type { MorphToastProps } from "../morph-toast.js";
import { usePinAction, usePinNudge } from "../pin-ceremony.js";
import { LONG_TEXT_CAP, truncateHead } from "../truncate.js";
import { SentAttachment } from "./attachments.js";
import { buildApprovalRequest } from "./approval-wire.js";
import {
  AGENT_CONTEXT_MARK,
  appTitle,
  buildFailureNotice,
  isAgentContext,
  narratedByAppCard,
  partData,
  toolCallIsContent,
  toolName,
  TURN_FAILURE_NOTICE,
  turnErrorSentence,
  type ApprovalWireMeta,
} from "./message-data.js";

/** ENG-218 — a plain user turn (rendered verbatim, not markdown) collapses when
    huge so a pasted log doesn't flood the thread with DOM. Assistant turns get
    the same treatment inside <Markdown>.

    Phantom-line guard (2026-07 demo feedback): `.fl-usertext` is pre-wrap, so
    trailing newlines in the SENT text paint as blank lines inside the bubble.
    The composer trims its own drafts, but host `sendMessage` calls and prefill
    bridges can carry a trailing "\n". Display strips the trailing-whitespace
    tail only — interior blank lines are content; copy still yields the raw
    text (userText in message-data). */
function UserText({ text: rawText, restored }: { text: string; restored?: boolean }) {
  const text = rawText.replace(/\s+$/, "");
  const [expanded, setExpanded] = useState(false);
  const collapsible = restored === true && text.length > LONG_TEXT_CAP;
  const shown = collapsible && !expanded ? truncateHead(text) : text;
  if (!collapsible) return <div className="fl-usertext">{text}</div>;
  // The collapsed head sits under a gradient fade with a
  // centered pill (GitHub-fold style) instead of a hard cut + inline link:
  // the fade shows the content continues, and the control sits where the
  // eye stops. Expanded keeps the pill below for symmetry.
  return (
    <div className={`fl-fold${expanded ? " fl-fold--open" : ""}`}>
      <div className="fl-usertext">{shown}</div>
      <div className="fl-fold-veil">
        <button type="button" className="fl-more fl-fold-pill" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? "Show less" : `Show full message (${(text.length / 1000).toFixed(0)}k chars)`}
        </button>
      </div>
    </div>
  );
}

/** The renderable half of a connect ask — the fields ConnectCard needs. */
type ConnectAsk = { connector: string; toolkit: string; message: string };

/** Read a connect ask off the flat `data-vendo-connect` shape (01 §16). */
function connectAsk(candidate: unknown): ConnectAsk | undefined {
  const fields = candidate as { connector?: unknown; toolkit?: unknown; message?: unknown } | null | undefined;
  if (typeof fields?.connector !== "string" || typeof fields.toolkit !== "string") return undefined;
  return {
    connector: fields.connector,
    toolkit: fields.toolkit,
    message: typeof fields.message === "string" ? fields.message : `Connect ${fields.toolkit} to continue.`,
  };
}

/** Read a connect ask off a NATIVE tool part's typed outcome — the engine
    path's shape, where the `connect-required` outcome IS the tool output.
    Undefined for any other result. */
function nativeConnectAsk(output: unknown): ConnectAsk | undefined {
  const result = output as { status?: unknown; connect?: unknown } | null | undefined;
  if (result?.status !== "connect-required") return undefined;
  return connectAsk(result.connect);
}

/** The in-thread connect card, shared by both wire shapes (see ThreadPart). */
function ThreadConnect({ ask, live, sendMessage }: {
  ask: ConnectAsk;
  live: boolean;
  sendMessage?: ((message: { text: string }) => unknown) | undefined;
}) {
  return (
    <ConnectCard
      connector={ask.connector}
      toolkit={ask.toolkit}
      message={ask.message}
      live={live}
      onConnected={() => {
        // The continuation: the account is live, so resume the turn. It
        // travels as agent context (hidden from the transcript) — the card's
        // own Connected badge already records the fact, and a fabricated
        // user bubble put words in the user's mouth (2026-08-06 polish; the
        // previous visible line was itself a rewrite of "retry
        // gmail_send_email").
        void sendMessage?.({ text: `${AGENT_CONTEXT_MARK} Connected ${toolkitDisplayName(ask.toolkit)}.` });
      }}
      onDeclined={() => {
        // "Not now" is an answer, and the agent is the one waiting on it —
        // without this it sits on a card the user already dismissed. Same
        // hidden-context carrier as the Connected line above: the Skipped row
        // is the visible record, so a user bubble would say it twice.
        void sendMessage?.({ text: `${AGENT_CONTEXT_MARK} Declined to connect ${toolkitDisplayName(ask.toolkit)}.` });
      }}
    />
  );
}

/** The shape both of a turn's terminal failures wear (spec §15 — the ✕ stays in
    the record): the failed tool call's own beat vocabulary — chrome, not the
    agent's prose — plus the line saying what happened. The line is the real
    message when there is one and the chrome's own third-person notice otherwise,
    so there is always something to read. */
function ThreadErrorBlock({ marker, headline, detail }: {
  /** The data attribute the E2E and a host's own styling select on, so it stays
      per-failure rather than collapsing into one shared name. */
  marker: "data-vendo-build-failed" | "data-vendo-turn-error";
  headline: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div className="fl-buildfail" {...{ [marker]: "" }}>
      <div className="fl-beat fl-beat-error">
        <span className="fl-beat-ic fl-beat-x" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </span>
        <span className="fl-beat-label">{headline}</span>
      </div>
      <div className="fl-approval-more" role="alert">{detail}</div>
    </div>
  );
}

/** A native tool call at its transcript position: the connector's ConnectCard
    when the call ended `connect-required`, otherwise its build beat.

    Spec §1 — THE TRANSCRIPT SHOWS THE WORK: every tool call leaves a beat at
    its position in the conversation (progress used to ride a status ribbon
    above the composer, leaving the transcript beat-free). Two exceptions:
      · the settled turn folds its beats into one summary row (hideBeats) —
        but a failed or declined call is content, not progress, so its ✕ beat
        stays visible either way (spec §15: the ✕ stays in the record);
      · D1 — an app-building call renders no beat, from the moment the build
        starts, because its card IS that step (the summary still counts it). */
function ToolCallPart({ part, risks, count, connectLive, hideBeats, sendMessage, siblingParts }: {
  part: ToolUIPart | DynamicToolUIPart;
  risks: Map<string, RiskLabel>;
  count: number;
  connectLive: boolean;
  hideBeats: boolean;
  sendMessage?: ((message: { text: string }) => unknown) | undefined;
  siblingParts?: UIMessage["parts"] | undefined;
}) {
  // 04-actions §3 — a connector call that ended `connect-required` renders
  // its ConnectCard IN PLACE (2026-07 demo feedback: the card used to hang
  // off the bottom of the list and vanish after the continuation; now it
  // lives at its transcript position and settles into a Connected record).
  // The typed outcome on the native tool part is the source of truth WHEN the
  // wire carries one; ThreadPart's data-vendo-connect branch covers the harness
  // wire, which does not.
  if (part.state === "output-available") {
    const ask = nativeConnectAsk(part.output);
    if (ask !== undefined) return <ThreadConnect ask={ask} live={connectLive} sendMessage={sendMessage} />;
  }
  // The narration check runs FIRST: a failed build is content (its ✕ stays in
  // the record), but its record is the build-failed block, not a second ✕.
  if (narratedByAppCard(part, siblingParts ?? [])) return null;
  if (hideBeats && !toolCallIsContent(part)) return null;
  return <BuildBeat part={part} risk={risks.get(part.toolCallId) ?? "read"} count={count} />;
}

/** One stream part in a turn: text (user verbatim / assistant markdown with the
    ENG-217 caret choreography), assistant files, tool build beats, and the
    jailed generated-view app card (06-apps §§8–9). */
export function ThreadPart({ part, partKey, role, restored, count = 1, risks, connectLive = false, hideBeats = false, turnPending = true, sendMessage, siblingParts, respond }: {
  part: UIMessage["parts"][number];
  partKey: string;
  role: UIMessage["role"];
  restored: boolean;
  count?: number;
  risks: Map<string, RiskLabel>;
  /** Spec §1 — the settled turn folded its beats into the summary row (see
      ThreadMessage), so successful calls render nothing until it reopens. */
  hideBeats?: boolean;
  /** Spec §8 + §15 — whether this turn is still working. A view whose payload
      is STILL `streaming` once the turn is over is a build that died: nothing
      will ever flip it to ready. Defaults to pending so a part rendered on its
      own (or by a host composing its own list) keeps today's behavior. */
  turnPending?: boolean;
  /** Whether a connect-required outcome in this turn is still the actionable
      ask (this is the LATEST assistant turn). Stale turns render the quiet
      Connected record instead — see ConnectCard's `live`. */
  connectLive?: boolean;
  /** The thread's send, for the post-connect continuation. */
  sendMessage?: (message: { text: string }) => unknown;
  /** The enclosing message's parts — the grant-set card reads its parked
      native call's state from the sibling tool part (same toolCallId). */
  siblingParts?: UIMessage["parts"];
  /** The thread's native approval response — the grant-set card resumes the
      parked turn with it after deciding the guard set over the wire. */
  respond?: (response: { id: string; approved: boolean }) => void;
}) {
  if (part.type === "text") {
    // The agent's grounding carrier is a text part nobody reads (message-data).
    if (isAgentContext(part)) return null;
    if (role === "user") return <UserText text={part.text} restored={restored} />;
    // ENG-217 — lone caret while the streamed turn is still empty (stable
    // line box); once text flows, Markdown's .fl-md--streaming trailing
    // caret takes over.
    if (part.state === "streaming" && part.text.trim().length === 0) {
      return <span className="fl-caret" aria-hidden="true" />;
    }
    return <Markdown text={part.text} streaming={part.state === "streaming"} restored={restored} />;
  }
  if (part.type === "file") {
    // ENG-225 — user attachments render beside the bubble (see the message
    // map); an assistant-authored file lands inline in the turn.
    if (role === "user") return null;
    return <SentAttachment part={part} />;
  }
  if (isToolUIPart(part)) {
    return (
      <ToolCallPart
        part={part}
        risks={risks}
        count={count}
        connectLive={connectLive}
        hideBeats={hideBeats}
        sendMessage={sendMessage}
        siblingParts={siblingParts}
      />
    );
  }
  if (part.type === "data-vendo-connect") {
    // The connect ask's OTHER shape, and the ONLY one a harness turn produces: the
    // runtime maps `connect-required` to a `denied` ToolResult and the wire mirror
    // writes a bare `tool-output-denied` (harnesses/src/wire.ts), so the native part
    // above carries no outcome to read — without this branch every unconnected
    // service on a harness turn is a silent denial with no card.
    const data = partData(part) as Partial<VendoConnectPart>;
    const ask = connectAsk(data);
    if (ask === undefined) return null;
    // The engine path writes BOTH shapes for one call (the bridge's part plus
    // the typed tool output). The native part stays the source of truth, so
    // when it already renders the card this one stands down — one card per call.
    const rendered = (siblingParts ?? []).filter(isToolUIPart).some(candidate =>
      candidate.toolCallId === data.toolCallId
      && candidate.state === "output-available"
      && nativeConnectAsk(candidate.output) !== undefined);
    if (rendered) return null;
    return <ThreadConnect ask={ask} live={connectLive} sendMessage={sendMessage} />;
  }
  if (part.type === "data-vendo-build-failed") {
    // 0.4.4 cert defect B — a terminally failed app build is content, not
    // progress: the turn ends right after this part, so without it the thread
    // showed no trace of why nothing appeared. Same beat vocabulary as a
    // failed tool call, plus what the failure MEANS for the reader.
    //
    // The reason is the runtime's own CLASSIFIED line ("timed out", "quota
    // exhausted", a missing `@ai-sdk/*` package) — written to be read, and the
    // half of the failure worth knowing, so it renders (buildFailureNotice).
    // The findings that quote the app's own code stay where they always
    // were: the server's `[vendo] app build failed (app_…)` log line.
    const data = partData(part) as Partial<VendoBuildFailedPart>;
    if (typeof data.reason !== "string" || data.reason.length === 0) return null;
    return (
      <ThreadErrorBlock
        marker="data-vendo-build-failed"
        headline={<>Couldn&apos;t build the app</>}
        detail={buildFailureNotice(data.reason)}
      />
    );
  }
  if (part.type === "data-vendo-turn-error") {
    // self-serve P — a turn whose stream errored is content, not progress: the
    // reply never arrives, so without this the transcript held an empty
    // assistant turn. Same beat vocabulary as a failed build, carrying the
    // agent's gated wire string (its "Vendo: " prefix is the wire's marker for
    // our OWN safe text — the reader gets the sentence, not the plumbing).
    const data = partData(part) as Partial<VendoTurnErrorPart>;
    if (typeof data.message !== "string" || data.message.length === 0) return null;
    // One shared reader with the banner (message-data): the marker comes off and
    // the operator's sentence renders as it was written. An UNPREFIXED string is
    // a raw provider/transport sentence and never reaches the reader, so the
    // chrome says what it knows in its own third-person voice instead.
    const message = turnErrorSentence(data.message);
    return (
      <ThreadErrorBlock
        marker="data-vendo-turn-error"
        headline={<>The response didn&rsquo;t finish</>}
        detail={message ?? TURN_FAILURE_NOTICE}
      />
    );
  }
  if (part.type === "data-vendo-step-limit") {
    // 2026-08-10 ruling — the step-cap notice is SYSTEM chrome, persisted. The
    // harness used to splice this sentence into the assistant's own text,
    // which put words in the model's mouth and fake memories in its
    // transcript. A quiet beat, not an error: nothing failed — the turn hit
    // its budget.
    const data = partData(part) as Partial<VendoStepLimitPart>;
    if (typeof data.message !== "string" || data.message.length === 0) return null;
    return (
      <div className="fl-beat" data-vendo-step-limit="">
        <span className="fl-beat-label">{data.message}</span>
      </div>
    );
  }
  if (part.type === "data-vendo-grant-set") {
    // demo-live-readiness 2026-07 — the grant-SET consent card renders at its
    // transcript position (like ConnectCard): actionable while its native
    // call is parked, then the settled record ("Enabled · N permissions
    // granted" / denied) — reload-safe, since the state derives from the
    // persisted sibling tool part, never component state.
    const data = partData(part) as Partial<VendoGrantSetPart>;
    const permissions = grantSetPermissions(data.permissions);
    if (typeof data.toolCallId !== "string" || typeof data.grantSetId !== "string"
      || typeof data.name !== "string"
      || permissions.length === 0) return null;
    return (
      <GrantSetConsent
        toolCallId={data.toolCallId}
        grantSetId={data.grantSetId}
        name={data.name}
        permissions={permissions}
        siblingParts={siblingParts ?? []}
        respond={respond}
      />
    );
  }
  if (part.type === "data-vendo-automation") {
    // 2026-07 demo feedback — a turn that creates/arms an automation renders
    // it AS an automation: the same card vocabulary as the workspace panel
    // (read-only here; management stays in the panel).
    const data = partData(part) as Partial<VendoAutomationPart>;
    if (typeof data.appId !== "string" || typeof data.name !== "string") return null;
    return (
      <AutomationCard
        name={data.name}
        enabled={data.enabled === true}
        {...(data.trigger === undefined ? {} : { trigger: data.trigger })}
        {...(typeof data.description === "string" ? { description: data.description } : {})}
        {...(typeof data.pendingGrants === "number" ? { pendingGrants: data.pendingGrants } : {})}
      />
    );
  }
  if (part.type === "data-vendo-citations") {
    // Knowledge K1 — rendered at TURN level (message.tsx → TurnCitations),
    // under the answer text the citations ground, matching the signed
    // mockups; at this part's transcript position the answer hasn't
    // streamed yet, so rendering here would put sources above the text.
    return null;
  }
  if (part.type === "data-vendo-view") {
    const data = partData(part) as Partial<VendoViewPart>;
    if (typeof data.appId !== "string" || !data.payload) return null;
    // Spec §8 + §15 — a build that DIED never flips `streaming` off: the last
    // partial view ever emitted is the skeleton. Left mounted, the card sweeps
    // its hairline over that skeleton forever on a turn that is over (§8 build
    // calm is a claim about the settled turn too), and it holds the split
    // view's stage on the same lie — the wave E2E photographed both. §15 says
    // what replaces it and it is not a component: the failed call's ✕ beat and
    // the agent's own prose, which are already in the turn. Unmounting also
    // withdraws the embed (the removeEmbed cleanup below), which is what
    // clears the stage.
    if (!turnPending && (data.payload as { streaming?: boolean }).streaming === true) return null;
    // 06-apps §§8–9 — in-thread surfaces are conversational previews, never
    // the approved in-client venue and never a drift report: both fields are
    // server-authoritative, so whatever the stream carried, render jailed
    // and notice-free.
    const {
      inClient: _neverInThread,
      pinDrift: _serverOnly,
      ...payload
    } = data.payload as typeof data.payload & { inClient?: unknown; pinDrift?: unknown };
    return <ThreadAppCard key={`${partKey}-${data.appId}`} buildKey={`${partKey}-${data.appId}`} appId={data.appId} payload={payload} restored={restored} />;
  }
  return null;
}

/**
 * H13 — the wire's grant-set permissions, VALIDATED instead of cast.
 *
 * THE DEFECT: the branch checked `Array.isArray` and then cast the whole array
 * to `GrantSetPermission[]`. A member missing its `risk` rendered a row reading
 * ": Send money" (`RISK_WORD[undefined]` is undefined), and its `approvalId` —
 * possibly undefined too — rode into `client.approvals.decide([undefined])` on
 * Approve, deciding nothing while the card claimed it had. Every field a row and
 * a decision need is checked here; a malformed member is dropped, and a set with
 * nothing left renders no card at all (the parked ask then keeps the ordinary
 * approval path).
 */
function grantSetPermissions(value: unknown): GrantSetPermission[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is GrantSetPermission => {
    const candidate = entry as Partial<GrantSetPermission> | null;
    return typeof candidate === "object" && candidate !== null
      && typeof candidate.approvalId === "string" && candidate.approvalId.length > 0
      && typeof candidate.tool === "string" && candidate.tool.length > 0
      && riskLabelSchema.options.includes(candidate.risk as RiskLabel);
  });
}

/** The grant-set card's wire half: derives parked/approved/denied from the
    sibling tool part carrying the SAME toolCallId, and on a decision settles
    the WHOLE set atomically — one approvals.decide over every member id
    (announced with the grantSetId so sibling surfaces resume too), then the
    native approval response that resumes this thread's parked turn. */
function GrantSetConsent({ toolCallId, grantSetId, name, permissions, siblingParts, respond }: {
  toolCallId: string;
  grantSetId: string;
  name: string;
  permissions: GrantSetPermission[];
  siblingParts: UIMessage["parts"];
  respond?: ((response: { id: string; approved: boolean }) => void) | undefined;
}) {
  const { client } = useVendoProvider();
  const sibling = siblingParts.filter(isToolUIPart).find(candidate => candidate.toolCallId === toolCallId);
  const approvedFlag = (sibling as { approval?: { approved?: boolean } } | undefined)?.approval?.approved;
  const state = sibling === undefined || sibling.state === "approval-requested" ? "parked" as const
    : sibling.state === "output-available" ? "approved" as const
    : sibling.state === "output-denied" ? "denied" as const
    // approval-responded (decision sent, resume in flight) and output-error
    // settle by the recorded decision direction.
    : approvedFlag === true ? "approved" as const
    : "denied" as const;
  const nativeApprovalId = sibling?.state === "approval-requested" ? sibling.approval.id : undefined;
  return (
    <GrantSetCard
      name={name}
      permissions={permissions}
      state={state}
      {...(state !== "parked" ? {} : {
        onDecide: async (approve: boolean) => {
          // One wire decision settles every ask in the set (criterion 19's
          // atomicity); the announcement carries the set id for any parked
          // sibling surface. The native response resumes THIS thread.
          await client.approvals.decide(
            permissions.map(permission => permission.approvalId),
            { approve },
            { grantSetId },
          );
          if (nativeApprovalId !== undefined) respond?.({ id: nativeApprovalId, approved: approve });
        },
      })}
    />
  );
}

/** Compact-preview geometry (2026-07 demo feedback): inside an overlay
    (compact modal AND the expanded rail) the in-thread card is a scaled-down
    PREVIEW — the full app renders on a fixed-width inner canvas and
    transform-scales to the card width (reads better than a scrollable crop),
    clamped to a short viewport with the Expand affordance prominent. The
    STAGE keeps full size; surfaces without a workspace (embedded
    threads) keep the full-size interactive card. */
const PREVIEW_CANVAS_WIDTH = 720;
const PREVIEW_MAX_HEIGHT = 300;

/** The app card's body. Inside a split view it is a scaled, inert PREVIEW
    (2026-07 demo feedback): the full app renders on a fixed-width canvas and
    transform-scales to the card width, with the Expand pill prominent, because
    the stage is the interactive venue. While the app is FEATURED on the stage
    the preview blurs under a centered "Full screened" label; collapse clears
    it. Everywhere else the body IS the full-size interactive card. */
function AppCardBody({ compact, shellRef, canvasRef, previewHeight, previewScale, featured, activate, splitExpanded, view }: {
  compact: boolean;
  shellRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  previewHeight: number;
  previewScale: number;
  featured: boolean;
  /** The card's activation, when the split view offers one. */
  activate: (() => void) | undefined;
  splitExpanded: boolean;
  /** The rendered app, built once by the caller: one element for both venues,
      so a preview and a full-size card can never show different things. */
  view: ReactNode;
}) {
  if (!compact) return <div className="fl-appcard-body">{view}</div>;
  return (
    <div
      ref={shellRef}
      className="fl-appcard-body fl-appcard-preview"
      {...(featured ? { "data-vendo-staged": "" } : {})}
      style={{ height: Math.min(previewHeight, PREVIEW_MAX_HEIGHT) }}
    >
      <div
        ref={canvasRef}
        className="fl-appcard-canvas"
        style={{ width: PREVIEW_CANVAS_WIDTH, transform: `scale(${previewScale})` }}
        {...(featured ? { "aria-hidden": true } : {})}
      >
        {view}
      </div>
      {featured ? (
        <div className="fl-appcard-veil" role="status">Full screened</div>
      ) : (
        <>
          {previewHeight > PREVIEW_MAX_HEIGHT ? <div className="fl-appcard-fade" aria-hidden="true" /> : null}
          {/* The prominent expand affordance, on compact-mode cards only:
              expanded-rail cards keep the bar's Feature button + card click as
              the stage-selection affordances. */}
          {activate !== undefined && !splitExpanded ? (
            <button type="button" className="fl-embed-expand" aria-label="Expand this view" onClick={activate}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
              Expand
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The in-thread generated-view card (06-apps §§8–9), split-view aware: it
    registers its FINAL payload with the enclosing overlay's workspace (when
    one exists) and, while the workspace is expanded, clicking the card
    features this app on the big stage. */
function ThreadAppCard({ appId, payload, restored, buildKey }: { appId: string; payload: UIPayload; restored: boolean; buildKey: string }) {
  const { client, components } = useVendoProvider();
  const pin = usePinAction();
  // A press inside the card's view that parks on the guard asks its question
  // over the conversation, where the person pressed it (the VendoSlot seam).
  // One per card mount: the stage renders its own view, and its own modal.
  const approval = useApprovalModal();
  // The destinations the registry knows — a mounted VendoSlot is the only thing
  // that can say a slot exists (hooks/use-slots.ts). More than one, and the
  // bar's placement affordance is a picker rather than a single fixed pin.
  const { slots } = useSlots();
  const split = useSplitView();
  const streaming = (payload as { streaming?: boolean }).streaming === true;
  // The nudge belongs to the build that just LANDED (§10.1: the user pins, the
  // agent never does). Restored history and a card still building are both
  // quiet — the second one matters twice over, because §8 gives a build exactly
  // one moving element and an invitation is not it.
  const nudge = usePinNudge(appId, !restored && !streaming);
  // When a LIVE build settles (streaming flips off), the full-size card
  // scrolls its own top into view once: stick-to-bottom otherwise leaves the
  // reader parked at the bottom of a tall app, mid-document with the title
  // off-screen (#537). Restored history never scrolls, and compact split-view
  // previews are height-clamped with the stage as the venue, so neither case
  // scrolls.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const presented = useRef(false);
  useEffect(() => {
    if (streaming || presented.current) return;
    presented.current = true;
    if (restored || split !== null) return;
    const card = cardRef.current;
    // jsdom leaves scrollIntoView undefined; browsers always have it.
    if (card && typeof card.scrollIntoView === "function") {
      card.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [streaming, restored, split]);
  // Compact preview measurement: scale = card width / canvas width; the
  // wrapper takes the scaled content height up to the clamp. Live-tracked —
  // the rail resizes across expand/collapse and content grows while apps
  // stream.
  const compact = split !== null;
  const shellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [previewScale, setPreviewScale] = useState(1);
  const [previewHeight, setPreviewHeight] = useState<number>(PREVIEW_MAX_HEIGHT);
  useEffect(() => {
    if (!compact) return;
    const shell = shellRef.current;
    const canvas = canvasRef.current;
    if (!shell || !canvas || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = shell.clientWidth;
      const scale = width > 0 ? Math.min(1, width / PREVIEW_CANVAS_WIDTH) : 1;
      setPreviewScale(scale);
      setPreviewHeight(canvas.offsetHeight * scale);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [compact]);
  // V4 (spec §5) — the brain's plan-time display hint. It knows the shape
  // before the fill, so a "stage" view opens the workspace at BUILD START,
  // where the plan's skeleton is actually visible; absent hint keeps today's
  // inline card.
  const staged = (payload as { display?: unknown }).display === "stage";
  // Register the finished view with the workspace stage; a re-stream of the
  // same app (regenerate) re-registers when streaming flips back off. The
  // registration carries the payload snapshot at settle time.
  //
  // A STAGED view also registers its FIRST streaming snapshot: the stage can
  // only feature an embed the split already knows, so without it the auto-open
  // below would land on an empty stage and hide the very skeleton the hint
  // exists to show. Only the first snapshot — the effect is keyed on the
  // streaming flip, never the payload, because re-registering per render would
  // dispatch a fresh state object every render.
  const registerEmbed = split?.registerEmbed;
  const removeEmbed = split?.removeEmbed;
  // M28 — a STAGED build has to keep up. The effect keyed on the streaming FLIP
  // alone, so the stage the hint opened froze on the first snapshot (usually the
  // bare skeleton) and stayed there for the whole build, while the small rail
  // card streamed live beside it — the big surface, the stale one. The dep is
  // the partial view's own PROGRESS rather than the payload object: the payload
  // is a fresh object every render, so keying on it would dispatch per render.
  // Known limit: progress is counted in NODES, so a stretch of the build that
  // only fills props in already-emitted nodes does not move the stage.
  const nodes = (payload as { nodes?: unknown }).nodes;
  const progress = Array.isArray(nodes) ? nodes.length : 0;
  useEffect(() => {
    if (!registerEmbed || (streaming && !staged)) return;
    registerEmbed(appId, payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerEmbed, appId, streaming, staged, progress]);
  useEffect(() => {
    if (!removeEmbed) return;
    return () => removeEmbed(appId);
  }, [removeEmbed, appId]);
  // Live turns only — restored history never reopens a stage. The one-shot
  // ledger lives in the split, not here: `autoStage` is idempotent per BUILD, so
  // the hint's shot is spent even when it arrives against an ALREADY-OPEN
  // workspace. A card-local ref could not record that — it returned early on
  // `split.expanded`, left the shot unspent, and the first Back-to-chat re-ran
  // this effect and re-opened the panel on the user's behalf (H9, §2 G1).
  // `autoStage` is identity-stable, so keying on it (not on `split`) also stops
  // every expand/collapse from re-running the effect.
  //
  // RULING 23 — the ledger key is this BUILD (message id + part index), not the
  // app. Keyed by app it was per-app for the life of the surface, so once the
  // user had collapsed a stage, an EXPLICIT new build request for the same app
  // never staged again. G1 forbids the UI opening ITSELF; honouring a fresh
  // request is not that.
  const autoStage = split?.autoStage;
  useEffect(() => {
    if (!staged || restored || !autoStage) return;
    autoStage(appId, buildKey);
  }, [staged, restored, autoStage, appId, buildKey]);
  const featured = split?.expanded === true && split.featuredAppId === appId;
  // The compact card's activation: expanded → feature on the stage;
  // collapsed → expand the workspace WITH this app staged. Clicking the card
  // (anywhere that isn't an interactive element) activates; the bar and the
  // preview's Expand pill carry explicit keyboard-reachable affordances.
  const activate = split !== null && !streaming
    ? () => (split.expanded ? split.feature(appId) : split.expandTo(appId))
    : undefined;
  const featureOnClick = activate !== undefined
    ? (event: React.MouseEvent) => {
        if (event.target instanceof Element
          && event.target.closest("button, a, input, textarea, select, [role='button']")) return;
        activate();
      }
    : undefined;
  return (
    <>
      {/* The generated view lives inside a clear app boundary — a titled
          frame — so it reads as a distinct piece of software, not loose
          content bleeding into the surrounding chat text. */}
      <div
        ref={cardRef}
        className="fl-uihost fl-appcard"
        data-vendo-app-embed={appId}
        {...(featured ? { "data-vendo-featured": "" } : {})}
        {...(featureOnClick ? { onClick: featureOnClick, "data-vendo-featurable": "" } : {})}
      >
        {/* The bar narrates forming → live. The data-state contract
            ("building" | "ready") is shared with the renderer; the label pair
            stays mounted so the swap crossfades. */}
        <div className="fl-appcard-bar" data-state={streaming ? "building" : "ready"}>
          <span className="fl-appcard-dot" aria-hidden="true" />
          <span className="fl-boot-labels fl-appcard-name">
            {/* Both labels stay mounted for the renderer lane's crossfade;
                aria-hidden tracks data-state so screen readers hear only the
                ACTIVE one (AI-review catch — the CSS-faded label was still
                announced, including a stale "Building…" after ready). */}
            <span className="fl-boot-building" aria-hidden={!streaming}>Building your view…</span>
            <span className="fl-boot-ready" aria-hidden={streaming}>{appTitle(payload) ?? "Your app"}</span>
          </span>
          {/* The workspace-feature affordance (keyboard path for "click the
              embed to feature it"); only while the split view is expanded and
              this card isn't already on the stage. */}
          {split?.expanded === true && !streaming && !featured ? (
            <button
              type="button"
              className="fl-barpin"
              aria-label="Show this view in the workspace"
              onClick={() => split.feature(appId)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
              Feature
            </button>
          ) : null}
          {/* The placement affordance lives ON the bar (visible only once the
              view is ready), replacing the old full-width footer row. The
              data-state/label/hairline markup above is the shared contract and
              stays untouched.

              ONE destination is a verb ("Pin to dashboard") — naming the only
              place it could go would be a menu of one. Several, and the same
              affordance becomes the picker: this card is the surface a real user
              actually reaches a generated view from, so it is where the choice
              has to live (the embed-only picker was unreachable in every host
              that renders its conversation through the overlay). */}
          {!streaming && pin ? (
            slots.length > 1 ? <AddToPicker appId={appId} /> : (
              <button
                type="button"
                className="fl-barpin"
                {...(nudge === undefined ? {} : { "data-vendo-pin": nudge })}
                onClick={() => pin({ appId, payload })}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 17v5M9 3h6l-1 7 3 3H7l3-3-1-7Z" />
                </svg>
                Pin to dashboard
              </button>
            )
          ) : null}
          <span className="fl-boot-hairline" aria-hidden="true" />
        </div>
        <AppCardBody
          compact={compact}
          shellRef={shellRef}
          canvasRef={canvasRef}
          previewHeight={previewHeight}
          previewScale={previewScale}
          featured={featured}
          activate={activate}
          splitExpanded={split?.expanded === true}
          view={
            <PayloadView
              payload={payload}
              components={components}
              onParked={approval.onParked}
              onAction={({ action, payload: actionPayload }) => client.apps.call(appId, action, actionPayload ?? {})}
            />
          }
        />
      </div>
      {/* OUTSIDE the card: a portal still bubbles its clicks up the REACT tree,
          and the card's own click features the app on the stage — dismissing the
          modal must not do that. */}
      {approval.modal}
    </>
  );
}

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

/** The parked in-thread approval cards: each builds its ApprovalRequest with
    the shared §16 wire builder (ENG-216), morphs into the top-right toast on
    approve (ENG-205), and decides the guard's record over the wire before resuming
    the model loop (05 §1). */
export function ThreadApprovals({ approvals, risks, guardApprovals, cardRefs, respond, onMorph }: {
  approvals: (ToolPart & { state: "approval-requested"; approval: { id: string } })[];
  risks: Map<string, RiskLabel>;
  guardApprovals: Map<string, ApprovalWireMeta>;
  cardRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  respond: (response: { id: string; approved: boolean }) => void;
  onMorph: (morph: Omit<MorphToastProps, "onDone">) => void;
}) {
  const { client, theme, tools } = useVendoProvider();
  // Below the mobile breakpoint the NEWEST parked approval
  // presents as a bottom sheet (thumb-zone consent); older parked ones stay
  // in-list behind it so the thread record is complete when the sheet closes.
  // Sheet presentation also needs viewport HEIGHT (voice-approval-overlap
  // regression): on short viewports the consent stays an in-list card so the
  // voice stage's controls remain reachable.
  const mobile = useApprovalSheetPresentation();
  return (
    <>
      {approvals.map((part, index) => {
        // Ruling 15 — no `data-vendo-approval` part means UNGRADED, not read:
        // the builder owns the cautious display default (approval-wire.ts).
        const risk = risks.get(part.toolCallId);
        const input = "input" in part ? part.input : undefined;
        const guardApproval = guardApprovals.get(part.toolCallId);
        const name = toolName(part);
        // spec §16 law 2 — the descriptor travels with the approval: one
        // builder shared with the queue, so a declared schema (when the wire
        // carries one) formats $47.50 as money IN-THREAD too, instead of the
        // old `inputSchema: {}` synthesis that read "4750 (unit not
        // specified)". No descriptor on the wire still yields a usable ask.
        const approval = buildApprovalRequest({
          approvalId: part.approval.id,
          toolCallId: part.toolCallId,
          tool: name,
          args: input,
          ...(risk === undefined ? {} : { risk }),
          ...(guardApproval?.invalidatedGrant === undefined
            ? {} : { invalidatedGrant: guardApproval.invalidatedGrant }),
          ...(guardApproval?.descriptor === undefined
            ? {} : { descriptor: guardApproval.descriptor }),
        }, tools);
        const guardApprovalId = guardApproval?.approvalId;
        const asSheet = mobile && index === approvals.length - 1;
        const card = (
          <div key={part.approval.id} ref={element => { cardRefs.current.set(part.approval.id, element); }}>
            <ApprovalCard
              approval={approval}
              showContext={false}
              allowRemember={guardApprovalId !== undefined}
              onDecide={async decision => {
                // The approved card lifts into the top-right notification
                // (ENG-205 morph) as the run resumes underneath it.
                if (decision.approve) {
                  const card = cardRefs.current.get(part.approval.id)?.querySelector<HTMLElement>(".fl-approval");
                  if (card) {
                    // L38 — the toast's title must be the CARD's title: without
                    // the descriptor's authored title (and its schema) this
                    // recomputed a bare humanization, so a card reading "Send
                    // money" morphed into a toast reading "Host transfer money
                    // — approved". Same arguments as the card's own
                    // presentation, from the request it just built.
                    const presentation = toolPresentation(
                      name,
                      input,
                      tools[name],
                      approval.descriptor.title,
                      approval.descriptor.inputSchema,
                    );
                    const rect = card.getBoundingClientRect();
                    card.style.transition = "opacity .22s ease";
                    card.style.opacity = "0";
                    onMorph({
                      startRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                      title: `${presentation.title} — approved`,
                      sub: presentation.sub ?? "Runs as you",
                      logoUrl: presentation.logoUrl,
                      theme,
                    });
                  }
                }
                // Decide the guard's approval record over the wire FIRST so the
                // resumed execution replays as approved (05 §1) — the native
                // response alone only tells the model loop to continue.
                if (guardApprovalId !== undefined) {
                  await client.approvals.decide([guardApprovalId], decision);
                }
                respond({ id: part.approval.id, approved: decision.approve });
              }}
            />
          </div>
        );
        return asSheet ? (
          <ApprovalSheet key={part.approval.id} label={`Approval for ${toolTitle(name, tools[name])}`}>
            {card}
          </ApprovalSheet>
        ) : card;
      })}
    </>
  );
}

