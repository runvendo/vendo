import type { ApprovalRequest, Json, RiskLabel, UIPayload, VendoAutomationPart, VendoBuildFailedPart, VendoGrantSetPart, VendoViewPart } from "@vendoai/core";
import { isToolUIPart, type UIMessage } from "ai";
import { useEffect, useRef, useState } from "react";
import { useVendoContext } from "../../context.js";
import { useSplitView } from "../split-view.js";
import { useApprovalSheetPresentation } from "../../hooks/use-mobile-takeover.js";
import { PayloadView } from "../../tree/renderer.js";
import { ApprovalCard } from "../approval-card.js";
import { ApprovalSheet } from "../approval-sheet.js";
import { AutomationCard } from "../automation-card.js";
import { BuildBeat, toolPresentation } from "../build-beat.js";
import { ConnectCard } from "../connect-card.js";
import { GrantSetCard, type GrantSetPermission } from "../grant-set-card.js";
import { toolkitDisplayName, toolTitle } from "../humanize.js";
import { Markdown } from "../markdown.js";
import type { MorphToastProps } from "../morph-toast.js";
import { LONG_TEXT_CAP, truncateHead } from "../truncate.js";
import { SentAttachment } from "./attachments.js";
import {
  appTitle,
  partData,
  preview,
  SYNTHESIZED_CREATED_AT,
  toolName,
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
  // Lane pick 3D — the collapsed head sits under a gradient fade with a
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

/** One stream part in a turn: text (user verbatim / assistant markdown with the
    ENG-217 caret choreography), assistant files, tool build beats, and the
    jailed generated-view app card (06-apps §§8–9). */
export function ThreadPart({ part, partKey, role, restored, count = 1, risks, connectLive = false, sendMessage, siblingParts, respond }: {
  part: UIMessage["parts"][number];
  partKey: string;
  role: UIMessage["role"];
  restored: boolean;
  count?: number;
  risks: Map<string, RiskLabel>;
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
    // 04-actions §3 — a connector call that ended `connect-required` renders
    // its ConnectCard IN PLACE (2026-07 demo feedback: the card used to hang
    // off the bottom of the list and vanish after the continuation; now it
    // lives at its transcript position and settles into a Connected record).
    // The typed outcome on the native tool part is the source of truth; the
    // data-vendo-connect part mirrors it for streaming consumers.
    if (part.state === "output-available") {
      const output = part.output as { status?: unknown; connect?: unknown } | undefined;
      const connect = output?.status === "connect-required"
        ? output.connect as { connector?: unknown; toolkit?: unknown; message?: unknown } | undefined
        : undefined;
      if (typeof connect?.connector === "string" && typeof connect.toolkit === "string") {
        const toolkit = connect.toolkit;
        return (
          <ConnectCard
            connector={connect.connector}
            toolkit={toolkit}
            message={typeof connect.message === "string" ? connect.message : `Connect ${toolkit} to continue.`}
            live={connectLive}
            onConnected={() => {
              // The continuation: the account is live, so resume the turn.
              // A NATURAL user line, not tool plumbing — the parked turn's
              // context (the connect-required call directly above) tells the
              // agent what to retry (2026-07 demo feedback; the old line
              // read "retry gmail_send_email" in the transcript).
              void sendMessage?.({ text: `Connected ${toolkitDisplayName(toolkit)}.` });
            }}
          />
        );
      }
    }
    // Lane pick C1 — live progress moved to the StatusRibbon above the
    // composer, so working/done calls leave NO transcript line (the
    // mechanical record stays in the Activity panel). A FAILED call is
    // content, not progress: it keeps the error beat so the failure stays
    // readable after the turn settles.
    if (part.state !== "output-error") return null;
    const risk = risks.get(part.toolCallId) ?? "read";
    return <BuildBeat part={part} risk={risk} count={count} />;
  }
  if (part.type === "data-vendo-build-failed") {
    // 0.4.4 cert defect B — a terminally failed app build is content, not
    // progress: the turn ends right after this part, so without it the thread
    // showed no trace of why nothing appeared. Same beat vocabulary as a
    // failed tool call, plus the runtime's classified (provider-safe) reason.
    const data = partData(part) as Partial<VendoBuildFailedPart>;
    if (typeof data.reason !== "string" || data.reason.length === 0) return null;
    return (
      <div className="fl-buildfail" data-vendo-build-failed="">
        <div className="fl-beat fl-beat-error">
          <span className="fl-beat-ic fl-beat-x" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </span>
          <span className="fl-beat-label">Couldn&apos;t build the app</span>
        </div>
        <div className="fl-approval-more" role="alert">{data.reason}</div>
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
    if (typeof data.toolCallId !== "string" || typeof data.grantSetId !== "string"
      || typeof data.name !== "string"
      || !Array.isArray(data.permissions) || data.permissions.length === 0) return null;
    return (
      <GrantSetConsent
        toolCallId={data.toolCallId}
        grantSetId={data.grantSetId}
        name={data.name}
        permissions={data.permissions as GrantSetPermission[]}
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
    // 06-apps §§8–9 — in-thread surfaces are conversational previews, never
    // the approved in-client venue and never a drift report: both fields are
    // server-authoritative, so whatever the stream carried, render jailed
    // and notice-free.
    const {
      inClient: _neverInThread,
      pinDrift: _serverOnly,
      ...payload
    } = data.payload as typeof data.payload & { inClient?: unknown; pinDrift?: unknown };
    return <ThreadAppCard key={`${partKey}-${data.appId}`} appId={data.appId} payload={payload} restored={restored} />;
  }
  return null;
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
  const { client } = useVendoContext();
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
    STAGE keeps full size; surfaces without a workspace (VendoPage, embedded
    threads) keep the full-size interactive card. */
const PREVIEW_CANVAS_WIDTH = 720;
const PREVIEW_MAX_HEIGHT = 300;

/** The in-thread generated-view card (06-apps §§8–9), split-view aware: it
    registers its FINAL payload with the enclosing overlay's workspace (when
    one exists) and, while the workspace is expanded, clicking the card
    features this app on the big stage. */
function ThreadAppCard({ appId, payload, restored }: { appId: string; payload: UIPayload; restored: boolean }) {
  const { client, components, onPin } = useVendoContext();
  const split = useSplitView();
  const streaming = (payload as { streaming?: boolean }).streaming === true;
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
  // Register the finished view with the workspace stage; a re-stream of the
  // same app (regenerate) re-registers when streaming flips back off. The
  // registration carries the payload snapshot at settle time.
  const registerEmbed = split?.registerEmbed;
  const removeEmbed = split?.removeEmbed;
  useEffect(() => {
    if (!registerEmbed || streaming) return;
    registerEmbed(appId, payload);
    // payload is a fresh object every render (destructured from the part);
    // keying the effect on it would re-register per render. appId + the
    // streaming flip are the real identity edges.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerEmbed, appId, streaming]);
  useEffect(() => {
    if (!removeEmbed) return;
    return () => removeEmbed(appId);
  }, [removeEmbed, appId]);
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
    // The generated view lives inside a clear app boundary — a titled
    // frame — so it reads as a distinct piece of software, not loose
    // content bleeding into the surrounding chat text.
    <div
      ref={cardRef}
      className="fl-uihost fl-appcard"
      data-vendo-app-embed={appId}
      {...(featured ? { "data-vendo-featured": "" } : {})}
      {...(featureOnClick ? { onClick: featureOnClick, "data-vendo-featurable": "" } : {})}
    >
      {/* Pick C (ui-lane-renderer): the bar narrates forming → live. The
          data-state contract ("building" | "ready") is shared with the
          thread lane; the label pair stays mounted so the swap crossfades. */}
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
        {/* Lane pick C5 (5A+5D) — the pin lives ON the bar (visible only once
            the view is ready), replacing the old full-width footer row. The
            renderer lane's data-state/label/hairline markup above is the
            shared contract and stays untouched. */}
        {!streaming && onPin ? (
          <button
            type="button"
            className="fl-barpin"
            onClick={() => onPin({ appId, payload })}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 17v5M9 3h6l-1 7 3 3H7l3-3-1-7Z" />
            </svg>
            Pin to dashboard
          </button>
        ) : null}
        <span className="fl-boot-hairline" aria-hidden="true" />
      </div>
      {compact ? (
        // Compact preview (2026-07 demo feedback): the full app renders on a
        // fixed-width canvas, transform-scaled to the card — inert (the stage
        // is the interactive venue) with the Expand pill prominent. While the
        // app is FEATURED on the stage, the preview blurs under a centered
        // "Full screened" label; collapse clears it.
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
            <PayloadView
              payload={payload}
              components={components}
              onAction={({ action, payload: actionPayload }) => client.apps.call(appId, action, actionPayload ?? {})}
            />
          </div>
          {featured ? (
            <div className="fl-appcard-veil" role="status">Full screened</div>
          ) : (
            <>
              {previewHeight > PREVIEW_MAX_HEIGHT ? <div className="fl-appcard-fade" aria-hidden="true" /> : null}
              {/* The prominent expand affordance, on compact-mode cards only:
                  expanded-rail cards keep the bar's Feature button + card
                  click as the stage-selection affordances. */}
              {activate !== undefined && split?.expanded !== true ? (
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
      ) : (
        <div className="fl-appcard-body">
          <PayloadView
            payload={payload}
            components={components}
            onAction={({ action, payload: actionPayload }) => client.apps.call(appId, action, actionPayload ?? {})}
          />
        </div>
      )}
    </div>
  );
}

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

/** The parked in-thread approval cards: each synthesizes an ApprovalRequest
    from the wire parts (ENG-216), morphs into the top-right toast on approve
    (ENG-205), and decides the guard's record over the wire before resuming
    the model loop (05 §1). */
export function ThreadApprovals({ approvals, risks, guardApprovals, cardRefs, respond, onMorph }: {
  approvals: (ToolPart & { state: "approval-requested"; approval: { id: string } })[];
  risks: Map<string, RiskLabel>;
  guardApprovals: Map<string, { approvalId?: string; invalidatedGrant?: ApprovalRequest["invalidatedGrant"] }>;
  cardRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  respond: (response: { id: string; approved: boolean }) => void;
  onMorph: (morph: Omit<MorphToastProps, "onDone">) => void;
}) {
  const { client, theme, tools } = useVendoContext();
  // Lane pick 1-H — below the mobile breakpoint the NEWEST parked approval
  // presents as a bottom sheet (thumb-zone consent); older parked ones stay
  // in-list behind it so the thread record is complete when the sheet closes.
  // Sheet presentation also needs viewport HEIGHT (voice-approval-overlap
  // regression): on short viewports the consent stays an in-list card so the
  // voice stage's controls remain reachable.
  const mobile = useApprovalSheetPresentation();
  return (
    <>
      {approvals.map((part, index) => {
        const risk = risks.get(part.toolCallId) ?? "read";
        const input = "input" in part ? part.input : undefined;
        const guardApproval = guardApprovals.get(part.toolCallId);
        const name = toolName(part);
        const approval: ApprovalRequest = {
          id: part.approval.id,
          call: { id: part.toolCallId, tool: name, args: input as Json },
          // The wire approval part carries no descriptor (01-core), so the
          // name is the raw tool id (ApprovalCard humanizes it) and the
          // description is left to host metadata — never a fabricated
          // "Approve <tool>" sentence.
          descriptor: { name, description: tools[name]?.description ?? "", inputSchema: {}, risk },
          inputPreview: preview(input),
          ...(guardApproval?.invalidatedGrant === undefined
            ? {}
            : { invalidatedGrant: guardApproval.invalidatedGrant }),
          // ENG-216 — the in-thread card renders inside the live conversation,
          // which IS its context, and the wire carries no ctx: rather than
          // invent a principal/venue/presence and stamp a per-render `new
          // Date()`, we hide the context byline in-thread (showContext=false)
          // and only structurally-true, stable values ride here (never shown).
          ctx: { principal: { kind: "user", subject: "" }, venue: "chat", presence: "present" },
          createdAt: SYNTHESIZED_CREATED_AT,
        };
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
                    const presentation = toolPresentation(name, input, tools[name]);
                    const rect = card.getBoundingClientRect();
                    card.style.transition = "opacity .22s ease";
                    card.style.opacity = "0";
                    onMorph({
                      startRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                      title: `${presentation.title} — approved`,
                      sub: presentation.sub ?? "Runs as you · recorded in Activity",
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

