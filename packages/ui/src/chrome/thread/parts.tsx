import type { ApprovalRequest, Json, RiskLabel, VendoViewPart } from "@vendoai/core";
import { isToolUIPart, type UIMessage } from "ai";
import { useState } from "react";
import { useVendoContext } from "../../context.js";
import { useMobileTakeover } from "../../hooks/use-mobile-takeover.js";
import { PayloadView } from "../../tree/renderer.js";
import { ApprovalCard } from "../approval-card.js";
import { ApprovalSheet } from "../approval-sheet.js";
import { BuildBeat, toolPresentation } from "../build-beat.js";
import { ConnectCard } from "../connect-card.js";
import { toolTitle } from "../humanize.js";
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
    the same treatment inside <Markdown>. */
export function UserText({ text, restored }: { text: string; restored?: boolean }) {
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
export function ThreadPart({ part, partKey, role, restored, count = 1, risks }: {
  part: UIMessage["parts"][number];
  partKey: string;
  role: UIMessage["role"];
  restored: boolean;
  count?: number;
  risks: Map<string, RiskLabel>;
}) {
  const { client, components, onPin } = useVendoContext();
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
    // Lane pick C1 — live progress moved to the StatusRibbon above the
    // composer, so working/done calls leave NO transcript line (the
    // mechanical record stays in the Activity panel). A FAILED call is
    // content, not progress: it keeps the error beat so the failure stays
    // readable after the turn settles.
    if (part.state !== "output-error") return null;
    const risk = risks.get(part.toolCallId) ?? "read";
    return <BuildBeat part={part} risk={risk} count={count} />;
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
    const streaming = (payload as { streaming?: boolean }).streaming === true;
    const appId = data.appId;
    return (
      // The generated view lives inside a clear app boundary — a titled
      // frame — so it reads as a distinct piece of software, not loose
      // content bleeding into the surrounding chat text.
      <div className="fl-uihost fl-appcard" key={`${partKey}-${appId}`}>
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
        <div className="fl-appcard-body">
          <PayloadView
            payload={payload}
            components={components}
            onAction={({ action, payload: actionPayload }) => client.apps.call(appId, action, actionPayload ?? {})}
          />
        </div>
      </div>
    );
  }
  return null;
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
  const mobile = useMobileTakeover().active;
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

/** 04-actions §3 — connector calls that ended `connect-required`, from the
    LAST assistant message only: a stale turn must not re-offer a connect
    (the persistent panel covers standing management). The typed outcome on
    the native tool part is the source of truth; the data-vendo-connect part
    mirrors it for streaming consumers, matching the approvals pattern. */
export function ThreadConnectRequests({ messages, sendMessage }: {
  messages: UIMessage[];
  sendMessage: (message: { text: string }) => unknown;
}) {
  const lastMessage = messages.at(-1);
  const connectRequests = (lastMessage?.role === "assistant" ? lastMessage.parts : [])
    .filter(isToolUIPart)
    .flatMap(part => {
      if (part.state !== "output-available") return [];
      const output = part.output as { status?: unknown; connect?: unknown } | undefined;
      const connect = output?.status === "connect-required"
        ? output.connect as { connector?: unknown; toolkit?: unknown; message?: unknown } | undefined
        : undefined;
      if (typeof connect?.connector !== "string" || typeof connect.toolkit !== "string") return [];
      return [{
        part,
        connector: connect.connector,
        toolkit: connect.toolkit,
        message: typeof connect.message === "string" ? connect.message : `Connect ${connect.toolkit} to continue.`,
      }];
    });
  return (
    <>
      {connectRequests.map(({ part, connector, toolkit, message }) => (
        <ConnectCard
          key={`connect-${part.toolCallId}`}
          connector={connector}
          toolkit={toolkit}
          message={message}
          onConnected={() => {
            // The retry: the account is live, so continue the turn — the
            // model re-issues the call, which now executes.
            void sendMessage({
              text: `I connected my ${toolkit} account — retry ${toolName(part)}.`,
            });
          }}
        />
      ))}
    </>
  );
}
