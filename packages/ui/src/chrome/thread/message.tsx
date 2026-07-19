import type { RiskLabel } from "@vendoai/core";
import { isToolUIPart, type UIMessage } from "ai";
import { Fragment } from "react";
import { useVendoContext } from "../../context.js";
import { useCopyFeedback } from "../clipboard.js";
import { toolTitle } from "../humanize.js";
import { SentAttachment, type FilePart } from "./attachments.js";
import { assistantText, collapseToolRuns, userText } from "./message-data.js";
import { ThreadPart } from "./parts.js";

/** Lane pick 8C — the settled turn's quiet sources row: every completed tool
    call the turn drew on, as informational chips ("what did it read?"). The
    full mechanical record stays in the Activity panel; these are the in-place
    scent. Only read-risk calls qualify — writes are actions, not sources. */
function TurnSources({ message, risks }: { message: UIMessage; risks: Map<string, RiskLabel> }) {
  const { tools } = useVendoContext();
  // Identical repeated calls collapse to one chip with a ×N count — the same
  // ENG-216 run-collapse identity (name + args) the old beat stack used.
  const sources = collapseToolRuns(message.parts).filter(({ part }) =>
    isToolUIPart(part) && part.state === "output-available"
    && (risks.get(part.toolCallId) ?? "read") === "read");
  if (sources.length === 0) return null;
  return (
    <div className="fl-sources" aria-label="Sources">
      {sources.map(({ part, count }) => {
        const toolPart = part as Extract<UIMessage["parts"][number], { toolCallId: string }>;
        const name = toolPart.type === "dynamic-tool"
          ? (toolPart as { toolName: string }).toolName
          : toolPart.type.replace(/^tool-/, "");
        return (
          <span className="fl-source" key={toolPart.toolCallId} title="Recorded in Activity">
            <i aria-hidden="true" />
            {toolTitle(name, tools[name])}
            {count > 1 ? <span className="fl-source-count" aria-label={`repeated ${count} times`}>×{count}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

/** ENG-225 — the copy turn action (.fl-turn-actions design). */
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

/** One turn in the transcript: the user attachments beside the bubble
    (ENG-225), the article with its stream parts, and the settled-turn
    actions (Copy always; Edit on the last user turn, Regenerate on the
    last assistant turn — ENG-215). */
export function ThreadMessage({ message, restored, risks, busy, activeAssistantId, lastUserId, lastAssistantId, onEditLast, onRegenerateLast }: {
  message: UIMessage;
  restored: boolean;
  risks: Map<string, RiskLabel>;
  busy: boolean;
  activeAssistantId?: string | undefined;
  lastUserId?: string | undefined;
  lastAssistantId?: string | undefined;
  onEditLast: () => void;
  onRegenerateLast: () => void;
}) {
  // ENG-225 — a user turn's attachments render BESIDE the bubble
  // (the designed .fl-turn-user-att block), not inside it; a
  // files-only send has no bubble at all.
  const sentFiles = message.role === "user"
    ? message.parts.filter((part): part is FilePart => part.type === "file")
    : [];
  const bubbleText = message.role === "user" ? userText(message) : assistantText(message);
  const skipBubble = message.role === "user" && bubbleText.length === 0
    && message.parts.every(part => part.type === "file");
  // ENG-225 — every settled turn carries a Copy action (hover-
  // revealed, see chrome-css); Edit stays on the last user turn and
  // Regenerate on the last assistant turn (ENG-215). The actively
  // streaming turn gets no actions — its text is still arriving.
  const streamingTurn = busy && message.role === "assistant" && message.id === activeAssistantId;
  const showEdit = !busy && message.role === "user" && message.id === lastUserId;
  const showRegenerate = !busy && message.role === "assistant" && message.id === lastAssistantId;
  const showActions = !streamingTurn && (bubbleText.length > 0 || showEdit || showRegenerate);
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
          {collapseToolRuns(message.parts).map(({ part, index, count }) => (
            <ThreadPart
              key={`${message.id}-${index}`}
              part={part}
              partKey={`${message.id}-${index}`}
              role={message.role}
              restored={restored}
              count={count}
              risks={risks}
            />
          ))}
          {!streamingTurn && message.role === "assistant" ? (
            <TurnSources message={message} risks={risks} />
          ) : null}
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
