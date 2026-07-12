import type { ApprovalRequest, Json, RiskLabel, ToolOutcome, VendoViewPart } from "@vendoai/core";
import { isToolUIPart, type UIMessage } from "ai";
import { useMemo, useState } from "react";
import { useVendoContext } from "../context.js";
import { useVendoThread } from "../hooks/use-vendo-thread.js";
import { PayloadView } from "../tree/renderer.js";
import { ApprovalCard } from "./approval-card.js";
import { ChromeRoot } from "./chrome-root.js";
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

/** Guard approval ids (apr_…) by tool call — carried in the data-vendo-approval
    part beside the native ai-SDK approval (whose own id is transport-local). */
function approvalIdByCall(messages: UIMessage[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-vendo-approval") continue;
      const data = partData(part) as { toolCallId?: unknown; approvalId?: unknown };
      if (typeof data.toolCallId === "string" && typeof data.approvalId === "string") {
        ids.set(data.toolCallId, data.approvalId);
      }
    }
  }
  return ids;
}

function toolName(part: Extract<UIMessage["parts"][number], { toolCallId: string }>): string {
  return part.type === "dynamic-tool" && "toolName" in part ? part.toolName : part.type.replace(/^tool-/, "");
}

function preview(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** 08-ui §4 — conversation chrome over the headless thread transport. */
export function VendoThread({ threadId }: { threadId?: string }) {
  const { client, components } = useVendoContext();
  const thread = useVendoThread(threadId);
  const [draft, setDraft] = useState("");
  const risks = useMemo(() => riskByCall(thread.messages), [thread.messages]);
  const guardApprovalIds = useMemo(() => approvalIdByCall(thread.messages), [thread.messages]);
  const busy = thread.status === "submitted" || thread.status === "streaming";

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void thread.sendMessage({ text });
  };

  const renderPart = (part: UIMessage["parts"][number], key: string, role: UIMessage["role"]) => {
    if (part.type === "text") {
      return role === "user"
        ? <div className="fl-usertext" key={key}>{part.text}</div>
        : <Markdown key={key} text={part.text} />;
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
      return (
        <PayloadView
          key={`${key}-${data.appId}`}
          payload={data.payload}
          components={components}
          onAction={({ action, payload }) => client.apps.call(data.appId!, action, payload ?? {})}
        />
      );
    }
    return null;
  };

  const approvals = thread.messages.flatMap(message => message.parts).filter(isToolUIPart).filter(part => part.state === "approval-requested");

  return (
    <ChromeRoot>
      <div className="fl-thread" role="region" aria-label="Vendo conversation">
        {/* role="log" — aria-label is prohibited on a roleless div (WCAG 4.1.2), and a
            streaming message list is exactly what "log" names. */}
        <div className="fl-msglist" role="log" aria-label="Conversation messages" aria-live="polite" aria-busy={busy}>
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
            const approval: ApprovalRequest = {
              id: part.approval.id,
              call: { id: part.toolCallId, tool: toolName(part), args: input as Json },
              descriptor: { name: toolName(part), description: `Approve ${toolName(part)}`, inputSchema: {}, risk },
              inputPreview: preview(input),
              ctx: { principal: { kind: "user", subject: "current-user", ephemeral: true }, venue: "chat", presence: "present" },
              createdAt: new Date().toISOString(),
            };
            const guardApprovalId = guardApprovalIds.get(part.toolCallId);
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
        </div>
        <form className="fl-composer" aria-label="Message composer" onSubmit={event => { event.preventDefault(); send(); }}>
          <div className="fl-composer-row">
            <label style={{ display: "contents" }}>
              <span className="fl-sr-only">Message</span>
              <textarea
                aria-label="Message"
                rows={1}
                value={draft}
                disabled={busy}
                onChange={event => setDraft(event.currentTarget.value)}
                onKeyDown={event => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
            </label>
            <button className="fl-icon-btn fl-send" type="submit" aria-label="Send" disabled={busy || !draft.trim()}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
              </svg>
              <span className="fl-sr-only">Send</span>
            </button>
            {busy ? (
              <button className="fl-icon-btn" type="button" aria-label="Stop" onClick={() => void thread.stop()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2.5" />
                </svg>
                <span className="fl-sr-only">Stop</span>
              </button>
            ) : null}
          </div>
          <span role="status" aria-live="polite" className="fl-sr-only">
            {thread.status === "error" && thread.error ? `error: ${thread.error.message}` : thread.status}
          </span>
        </form>
      </div>
    </ChromeRoot>
  );
}
