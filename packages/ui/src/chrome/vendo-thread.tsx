import type { ApprovalRequest, Json, RiskLabel, ToolOutcome, VendoViewPart } from "@vendoai/core";
import { isToolUIPart, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVendoContext } from "../context.js";
import { useVendoThread } from "../hooks/use-vendo-thread.js";
import { PayloadView } from "../tree/renderer.js";
import { ApprovalCard } from "./approval-card.js";
import { ChromeRoot } from "./chrome-root.js";
import { FluidThinking } from "./fluid-thinking.js";
import { Markdown } from "./markdown.js";

function partData(part: UIMessage["parts"][number]): unknown {
  return "data" in part ? part.data : part;
}

function riskByCall(messages: UIMessage[]): Map<string, RiskLabel> {
  const risks = new Map<string, RiskLabel>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-vendo-approval") continue;
      const data = partData(part) as { toolCallId?: unknown; risk?: unknown };
      if (typeof data.toolCallId === "string" && ["read", "write", "destructive"].includes(String(data.risk))) {
        risks.set(data.toolCallId, data.risk as RiskLabel);
      }
    }
  }
  return risks;
}

/** Guard approval metadata by tool call — carried in the data-vendo-approval
    part beside the native ai-SDK approval (whose own id is transport-local). */
function approvalByCall(messages: UIMessage[]): Map<string, {
  approvalId?: string;
  invalidatedGrant?: ApprovalRequest["invalidatedGrant"];
}> {
  const approvals = new Map<string, {
    approvalId?: string;
    invalidatedGrant?: ApprovalRequest["invalidatedGrant"];
  }>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-vendo-approval") continue;
      const data = partData(part) as {
        toolCallId?: unknown;
        approvalId?: unknown;
        invalidatedGrant?: { id?: unknown; grantedAt?: unknown };
      };
      if (typeof data.toolCallId !== "string") continue;
      approvals.set(data.toolCallId, {
        ...(typeof data.approvalId === "string" ? { approvalId: data.approvalId } : {}),
        ...(typeof data.invalidatedGrant?.id === "string"
          && typeof data.invalidatedGrant.grantedAt === "string"
          ? { invalidatedGrant: data.invalidatedGrant as NonNullable<ApprovalRequest["invalidatedGrant"]> }
          : {}),
      });
    }
  }
  return approvals;
}

function toolName(part: Extract<UIMessage["parts"][number], { toolCallId: string }>): string {
  return part.type === "dynamic-tool" && "toolName" in part ? part.toolName : part.type.replace(/^tool-/, "");
}

/** A picked File → an ai-SDK FileUIPart (data URL) so it can ride the turn. */
function fileToPart(file: File): Promise<{ type: "file"; mediaType: string; filename: string; url: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.onload = () => resolve({
      type: "file",
      mediaType: file.type || "application/octet-stream",
      filename: file.name,
      url: String(reader.result),
    });
    reader.readAsDataURL(file);
  });
}

function preview(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** Within this many pixels of the end the reader counts as "at the bottom" —
    a paragraph of slack so sub-line wobble (fractional scroll positions,
    entrance easing) never breaks the stick. */
const BOTTOM_SLACK_PX = 32;

/** ENG-213 — scroll management for the message list.

    Stick-to-bottom: while the reader is at the end, every content change
    (history load, streamed deltas, tool chips, approvals) keeps the latest
    content in view. The moment the reader scrolls up, the stick releases —
    streaming must never yank them — and it re-arms when they return to the
    bottom on their own. Jump-to-latest: when new content lands while the
    reader is scrolled up, the stylesheet's .fl-jump affordance appears;
    activating it scrolls to the latest turn and re-sticks. */
function useStickToBottom(messages: UIMessage[]) {
  const listRef = useRef<HTMLDivElement>(null);
  // The stick is a ref, not state: it flips inside scroll/effect timing and
  // must be readable synchronously without re-render races.
  const stuckRef = useRef(true);
  const lastScrollHeightRef = useRef(0);
  const [unseen, setUnseen] = useState(false);

  const atBottom = (node: HTMLElement) =>
    node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_SLACK_PX;

  const onScroll = () => {
    const node = listRef.current;
    if (!node) return;
    // Both user scrolls and our own programmatic sticks land here; either way
    // the reader's actual position is the single source of truth.
    stuckRef.current = atBottom(node);
    if (stuckRef.current) setUnseen(false);
  };

  const jumpToLatest = () => {
    const node = listRef.current;
    if (!node) return;
    stuckRef.current = true;
    setUnseen(false);
    node.scrollTop = node.scrollHeight;
  };

  // After every content change: stick if the reader is at the bottom, or flag
  // the new content if they've scrolled away. Layout effects would run before
  // paint, but streamed markdown re-renders arrive in bursts — post-paint is
  // indistinguishable here and cheaper.
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const grew = node.scrollHeight > lastScrollHeightRef.current;
    lastScrollHeightRef.current = node.scrollHeight;
    if (stuckRef.current) {
      node.scrollTop = node.scrollHeight;
    } else if (grew) {
      setUnseen(true);
    }
  }, [messages]);

  return { listRef, onScroll, jumpToLatest, showJump: unseen };
}

export interface VendoThreadProps {
  threadId?: string;
  /** Landing headline shown above the composer while the thread is empty. */
  greeting?: string;
  /** Starter prompts shown as chips on the empty landing; clicking sends one. */
  suggestions?: string[];
  /** Show a mic affordance in the composer that launches the host's voice surface. */
  onVoice?: () => void;
}

/** 08-ui §4 — conversation chrome over the headless thread transport. */
export function VendoThread({
  threadId,
  greeting = "What can I help you build?",
  suggestions = [],
  onVoice,
}: VendoThreadProps) {
  const { client, components } = useVendoContext();
  const thread = useVendoThread(threadId);
  const scroll = useStickToBottom(thread.messages);
  const [draft, setDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const risks = useMemo(() => riskByCall(thread.messages), [thread.messages]);
  const guardApprovals = useMemo(() => approvalByCall(thread.messages), [thread.messages]);
  const busy = thread.status === "submitted" || thread.status === "streaming";
  const landing = thread.messages.length === 0;
  const activeAssistant = thread.messages.at(-1)?.role === "assistant" ? thread.messages.at(-1) : undefined;
  const assistantHasVisibleText = activeAssistant?.parts.some(
    part => part.type === "text" && part.text.trim().length > 0,
  ) ?? false;
  const working = busy && !assistantHasVisibleText;

  const [attachError, setAttachError] = useState<string>();
  const send = (override?: string) => {
    const text = (override ?? draft).trim();
    if ((!text && files.length === 0) || busy) return;
    const pending = files;
    void (async () => {
      let parts: Awaited<ReturnType<typeof fileToPart>>[];
      try {
        parts = await Promise.all(pending.map(fileToPart));
      } catch (reason) {
        // A file read failed — DON'T clear the draft/attachments, or the message
        // would vanish silently. Surface the error and let the user retry.
        setAttachError(reason instanceof Error ? reason.message : "Couldn't read an attachment.");
        return;
      }
      // Only clear once the turn is committed.
      setAttachError(undefined);
      setDraft("");
      setFiles([]);
      if (fileRef.current) fileRef.current.value = "";
      void thread.sendMessage(parts.length > 0 ? { text, files: parts } : { text });
    })();
  };

  const composer = (
    <form className="fl-composer" aria-label="Message composer" onSubmit={event => { event.preventDefault(); send(); }}>
      {attachError ? <div className="fl-att-error" role="alert">{attachError}</div> : null}
      {files.length > 0 ? (
        <div className="fl-att-chips">
          {files.map((file, i) => (
            <span className="fl-att-file" key={`${file.name}-${i}`}>
              <span className="fl-att-name">{file.name}</span>
              <button type="button" className="fl-att-rm fl-att-rm-file" aria-label={`Remove ${file.name}`}
                onClick={() => setFiles(current => current.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="fl-composer-row">
        <input ref={fileRef} type="file" multiple hidden aria-hidden="true"
          onChange={event => { if (event.target.files) setFiles(current => [...current, ...Array.from(event.target.files!)]); }} />
        <button type="button" className="fl-icon-btn fl-attach" aria-label="Attach files" onClick={() => fileRef.current?.click()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <label style={{ display: "contents" }}>
          <span className="fl-sr-only">Message</span>
          <textarea
            aria-label="Message"
            placeholder="Ask anything"
            rows={1}
            value={draft}
            disabled={busy}
            onChange={event => setDraft(event.currentTarget.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }}
          />
        </label>
        {onVoice ? (
          <button type="button" className="fl-icon-btn" aria-label="Start voice" onClick={onVoice}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 19v3" />
            </svg>
          </button>
        ) : null}
        {busy ? (
          <button className="fl-icon-btn" type="button" aria-label="Stop" onClick={() => void thread.stop()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
            <span className="fl-sr-only">Stop</span>
          </button>
        ) : (
          <button className="fl-icon-btn fl-send" type="submit" aria-label="Send" disabled={!draft.trim() && files.length === 0}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
            </svg>
            <span className="fl-sr-only">Send</span>
          </button>
        )}
      </div>
      <span role="status" aria-live="polite" className="fl-sr-only">
        {thread.status === "error" && thread.error ? `error: ${thread.error.message}` : thread.status}
      </span>
    </form>
  );

  const renderPart = (part: UIMessage["parts"][number], key: string, role: UIMessage["role"]) => {
    if (part.type === "text") {
      return role === "user"
        ? <div className="fl-usertext" key={key}>{part.text}</div>
        : <Markdown key={key} text={part.text} streaming={part.state === "streaming"} />;
    }
    if (isToolUIPart(part)) {
      const risk = risks.get(part.toolCallId) ?? "read";
      const error = part.state === "output-error";
      const done = part.state === "output-available";
      return (
        <div
          className={`fl-tool ${error ? "fl-tool-error" : done ? "fl-tool-done" : "fl-tool-working"}`}
          data-vendo-approval={risk}
          key={key}
        >
          {error ? (
            <span className="fl-tool-icon" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </span>
          ) : done ? (
            <span className="fl-tool-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m5 12 4 4L19 6" />
              </svg>
            </span>
          ) : <span className="fl-tool-spinner" aria-hidden="true" />}
          <span className="fl-tool-label">Tool: {toolName(part)}</span>
          <span className="fl-tool-detail" data-risk={risk}>{risk}</span>
          <span className="fl-tool-detail">{part.state}</span>
        </div>
      );
    }
    if (part.type === "data-vendo-view") {
      const data = partData(part) as Partial<VendoViewPart>;
      if (typeof data.appId !== "string" || !data.payload) return null;
      // 06-apps §9 — in-thread surfaces are conversational previews, never the
      // approved in-client venue: whatever the stream carried, render jailed.
      const { inClient: _neverInThread, ...payload } = data.payload as typeof data.payload & { inClient?: unknown };
      return (
        <PayloadView
          key={`${key}-${data.appId}`}
          payload={payload}
          components={components}
          onAction={({ action, payload }) => client.apps.call(data.appId!, action, payload ?? {})}
        />
      );
    }
    return null;
  };

  const approvals = thread.messages.flatMap(message => message.parts).filter(isToolUIPart).filter(part => part.state === "approval-requested");

  if (landing) {
    return (
      <ChromeRoot>
        <div className="fl-thread" role="region" aria-label="Vendo conversation">
          <div className="fl-landing">
            <h1 className="fl-greet">{greeting}</h1>
            <div className="fl-landing-composer">{composer}</div>
            {suggestions.length > 0 ? (
              <div className="fl-chips">
                {suggestions.map((text, i) => (
                  <button type="button" className="fl-chip" key={`${i}-${text}`} onClick={() => send(text)}>{text}</button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </ChromeRoot>
    );
  }

  return (
    <ChromeRoot>
      <div className="fl-thread" role="region" aria-label="Vendo conversation">
        {/* role="log" — aria-label is prohibited on a roleless div (WCAG 4.1.2), and a
            streaming message list is exactly what "log" names. */}
        <div className="fl-msglist-wrap">
        <div
          className="fl-msglist"
          role="log"
          aria-label="Conversation messages"
          aria-live="polite"
          aria-busy={busy}
          ref={scroll.listRef}
          onScroll={scroll.onScroll}
        >
          {thread.messages.map(message => (
            <article
              className={message.role === "user" ? "fl-turn-user" : "fl-turn-assistant"}
              data-role={message.role}
              key={message.id}
              aria-label={`${message.role} message`}
            >
              {message.parts.map((part, index) => renderPart(part, `${message.id}-${index}`, message.role))}
            </article>
          ))}
          {approvals.map(part => {
            const risk = risks.get(part.toolCallId) ?? "read";
            const input = "input" in part ? part.input : undefined;
            const guardApproval = guardApprovals.get(part.toolCallId);
            const approval: ApprovalRequest = {
              id: part.approval.id,
              call: { id: part.toolCallId, tool: toolName(part), args: input as Json },
              descriptor: { name: toolName(part), description: `Approve ${toolName(part)}`, inputSchema: {}, risk },
              inputPreview: preview(input),
              ...(guardApproval?.invalidatedGrant === undefined
                ? {}
                : { invalidatedGrant: guardApproval.invalidatedGrant }),
              ctx: { principal: { kind: "user", subject: "current-user", ephemeral: true }, venue: "chat", presence: "present" },
              createdAt: new Date().toISOString(),
            };
            const guardApprovalId = guardApproval?.approvalId;
            return (
              <ApprovalCard
                key={part.approval.id}
                approval={approval}
                allowRemember={guardApprovalId !== undefined}
                onDecide={async decision => {
                  // Decide the guard's approval record over the wire FIRST so the
                  // resumed execution replays as approved (05 §1) — the native
                  // response alone only tells the model loop to continue.
                  if (guardApprovalId !== undefined) {
                    await client.approvals.decide([guardApprovalId], decision);
                  }
                  thread.addToolApprovalResponse({ id: part.approval.id, approved: decision.approve });
                }}
              />
            );
          })}
          {working ? <FluidThinking label="Working" /> : null}
        </div>
        {scroll.showJump ? (
          <button type="button" className="fl-jump" aria-label="Jump to latest" onClick={scroll.jumpToLatest}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14" /><path d="m19 12-7 7-7-7" />
            </svg>
          </button>
        ) : null}
        </div>
        {composer}
      </div>
    </ChromeRoot>
  );
}
