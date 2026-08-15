import type { RiskLabel } from "@vendoai/core";
import { isToolUIPart, type UIMessage } from "ai";
import { Fragment, useRef, useState } from "react";
import { BeatSummary } from "../build-beat.js";
import { useCopyFeedback } from "../clipboard.js";
import { SentAttachment, type FilePart } from "./attachments.js";
import { assistantText, collapseToolRuns, isAgentContext, toolCallIsContent, toolCallParked, toolCallPending, userText } from "./message-data.js";
import { ThreadPart } from "./parts.js";
import { TurnCitations } from "./turn-citations.js";

// 2026-07 demo feedback — the settled turn's "sources" chip row is GONE: the
// little read-call pills under assistant messages read as clutter and
// duplicated the audit trail, which remains the mechanical record. The turn's
// work comes back as BEATS — a checklist
// line per call while the turn runs, folded into one reopenable summary row
// ("Did 4 things · 7.1s") the moment it settles.

/** The copy turn action (.fl-turn-actions design). */
function CopyTurnButton({ text }: { text: string }) {
  const [copied, copy] = useCopyFeedback();
  return (
    <button type="button" className="fl-turn-btn" aria-label="Copy message" onClick={() => copy(text)}>
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect width="13" height="13" x="9" y="9" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** One turn in the transcript: the user attachments beside the bubble, the
    article with its stream parts, and the settled-turn actions (Copy always;
    Edit on the last user turn, Regenerate on the last assistant turn). */
export function ThreadMessage({ message, restored, risks, busy, activeAssistantId, lastUserId, lastAssistantId, onEditLast, onRegenerateLast, sendMessage, respond }: {
  message: UIMessage;
  restored: boolean;
  risks: Map<string, RiskLabel>;
  busy: boolean;
  activeAssistantId?: string | undefined;
  lastUserId?: string | undefined;
  lastAssistantId?: string | undefined;
  onEditLast: () => void;
  onRegenerateLast: () => void;
  /** The thread's send — connect cards use it for the post-connect continuation. */
  sendMessage?: (message: { text: string }) => unknown;
  /** The thread's native approval response — grant-set cards resume with it. */
  respond?: (response: { id: string; approved: boolean }) => void;
}) {
  // A user turn's attachments render BESIDE the bubble
  // (the designed .fl-turn-user-att block), not inside it; a
  // files-only send has no bubble at all.
  const sentFiles = message.role === "user"
    ? message.parts.filter((part): part is FilePart => part.type === "file")
    : [];
  const bubbleText = message.role === "user" ? userText(message) : assistantText(message);
  const skipBubble = message.role === "user" && bubbleText.length === 0
    && message.parts.every(part => part.type === "file" || isAgentContext(part));
  // Every settled turn carries a Copy action (hover-
  // revealed, see chrome-css); Edit stays on the last user turn and
  // Regenerate on the last assistant turn.
  const streamingTurn = busy && message.role === "assistant" && message.id === activeAssistantId;
  const showEdit = !busy && message.role === "user" && message.id === lastUserId;
  const showRegenerate = !busy && message.role === "assistant" && message.id === lastAssistantId;
  // The turn's beats fold into ONE summary row once the whole turn
  // has settled: while any call is still working (or parked on an approval)
  // every beat stays open, and the fold waits. Restored history arrives folded,
  // which is also what keeps a long thread from a beat entrance stampede.
  const items = collapseToolRuns(message.parts);
  const calls = items.filter(item => isToolUIPart(item.part));
  const pending = streamingTurn || calls.some(item => toolCallPending(item.part));
  // A turn whose text is still arriving gets no actions, and neither does one
  // PARKED on a consent card: the row reserved 33px between the "waiting for
  // your approval" beat and the card under it, breaking them into two separate
  // moments. On the last turn that row is not even invisible — chrome-css's
  // `.fl-turn-assistant:last-child .fl-turn-actions` reveals it without a
  // hover — so this is a real gap, not just reserved space.
  //
  // The gate is the PARKED ask, never the broad `pending`: a turn stopped
  // mid-call keeps a tool part in `input-available` forever (thread.stop()
  // does not reconcile the aborted call), so `pending` stays true and
  // Copy/Regenerate would never come back on the last turn.
  const parked = calls.some(item => toolCallParked(item.part));
  const showActions = !streamingTurn && !parked && (bubbleText.length > 0 || showEdit || showRegenerate);
  // A failed or declined call is not one of the "things I did", and its ✕ beat
  // never folds — so the count is the work that actually landed, and
  // the failure keeps its own line right where it happened.
  const steps = calls.filter(item => !toolCallIsContent(item.part));
  const [beatsOpen, setBeatsOpen] = useState(false);
  const summarized = steps.length > 0 && !pending;
  const folded = summarized && !beatsOpen;
  const summaryAt = steps[0]?.index;
  // Wall time: the wire carries no per-part timestamps, so the clock is
  // measured — started when the turn was first seen working, frozen at settle.
  // A turn nobody watched work shows the count alone rather than an invented
  // duration.
  //
  // M26 — that last rule leaned on `pending` being false for history, which is
  // false in the one case it matters: a turn that was ALREADY RUNNING when this
  // surface first saw it (a reopened conversation, a reload mid-turn) is both
  // restored AND pending, so the clock started at the moment we arrived and the
  // row reported "· 1.2s" for a turn that had been working for thirty. `restored`
  // is exactly "we did not watch this start", so it gates the clock: unknown
  // start ⇒ the count alone, which the comment above already required.
  const clock = useRef<{ start?: number; seconds?: number }>({});
  if (pending && !restored) clock.current.start ??= Date.now();
  else if (clock.current.start !== undefined) {
    clock.current.seconds ??= (Date.now() - clock.current.start) / 1000;
  }
  return (
    <Fragment>
      {sentFiles.length > 0 ? (
        <div className={`fl-turn-user-att${restored ? " fl-no-entrance" : ""}`}>
          {sentFiles.map((part, index) => <SentAttachment key={index} part={part} />)}
        </div>
      ) : null}
      {skipBubble ? null : (
        <article
          className={`${message.role === "user" ? "fl-turn-user" : "fl-turn-assistant"}${
            restored ? " fl-no-entrance" : ""}`}
          data-role={message.role}
          aria-label={`${message.role} message`}
        >
          {items.map(({ part, index, count }) => (
            <Fragment key={`${message.id}-${index}`}>
              {/* The settled turn's one row, standing where its first beat is —
                  the same place folded or reopened, so a double-click doesn't
                  move the control out from under the pointer. */}
              {summarized && index === summaryAt ? (
                <BeatSummary
                  steps={steps.length}
                  seconds={clock.current.seconds}
                  open={beatsOpen}
                  onToggle={() => setBeatsOpen(open => !open)}
                />
              ) : null}
              <ThreadPart
                part={part}
                partKey={`${message.id}-${index}`}
                role={message.role}
                restored={restored}
                count={count}
                risks={risks}
                // A connect ask is actionable only in the LATEST assistant turn;
                // older cards settle into the Connected record (or nothing).
                connectLive={message.role === "assistant" && message.id === lastAssistantId}
                hideBeats={folded}
                turnPending={pending}
                // …and the narrower question the forming card asks: `pending`
                // survives a stop (see the note above it), `streamingTurn` does
                // not, so an abandoned build's empty card stands down.
                turnLive={streamingTurn}
                sendMessage={sendMessage}
                siblingParts={message.parts}
                respond={respond}
              />
            </Fragment>
          ))}
          {/* Knowledge K1 — the turn's knowledge trust surface (citation
              chips / refusal line / unavailable flag) renders at the BOTTOM
              of the turn, under the answer it grounds (signed mockups,
              Surface 2) — not at the citations part's transcript position,
              which precedes the streamed answer text. */}
          {message.role === "assistant" && !streamingTurn ? <TurnCitations message={message} /> : null}
          {showActions ? (
            <div className="fl-turn-actions">
              {bubbleText.length > 0 ? <CopyTurnButton text={bubbleText} /> : null}
              {showEdit ? (
                <button type="button" className="fl-turn-btn" aria-label="Edit message" onClick={onEditLast}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                  Edit
                </button>
              ) : null}
              {showRegenerate ? (
                <button type="button" className="fl-turn-btn" aria-label="Regenerate" onClick={onRegenerateLast}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" />
                  </svg>
                  Regenerate
                </button>
              ) : null}
            </div>
          ) : null}
        </article>
      )}
    </Fragment>
  );
}
