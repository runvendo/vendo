import type { ApprovalRequest, Json, RiskLabel, ToolOutcome, VendoViewPart } from "@vendoai/core";
import { isToolUIPart, type UIMessage } from "ai";
import { useMemo, useState } from "react";
import { useVendoContext } from "../context.js";
import { useVendoThread } from "../hooks/use-vendo-thread.js";
import { PayloadView } from "../tree/renderer.js";
import { ApprovalCard } from "./approval-card.js";
import { ChromeRoot } from "./chrome-root.js";
import { NoPolicyNotice } from "./no-policy-notice.js";

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
  const busy = thread.status === "submitted" || thread.status === "streaming";

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void thread.sendMessage({ text });
  };

  const renderPart = (part: UIMessage["parts"][number], key: string) => {
    if (part.type === "text") return <p key={key}>{part.text}</p>;
    if (isToolUIPart(part)) {
      const risk = risks.get(part.toolCallId) ?? "read";
      return (
        <div className="vendo-tool-receipt" data-vendo-approval={risk} key={key}>
          <span>Tool: {toolName(part)}</span>
          <span className="vendo-chip" data-risk={risk}>{risk}</span>
          <span>{part.state}</span>
        </div>
      );
    }
    if (part.type === "data-vendo-view") {
      const data = partData(part) as Partial<VendoViewPart>;
      if (typeof data.appId !== "string" || !data.payload) return null;
      return (
        <PayloadView
          key={key}
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
      <section className="vendo-thread" aria-label="Vendo conversation">
        <NoPolicyNotice />
        {/* role="log" — aria-label is prohibited on a roleless div (WCAG 4.1.2), and a
            streaming message list is exactly what "log" names. */}
        <div className="vendo-messages" role="log" aria-label="Conversation messages" aria-live="polite" aria-busy={busy}>
          {thread.messages.map(message => (
            <article className="vendo-message" data-role={message.role} key={message.id} aria-label={`${message.role} message`}>
              {message.parts.map((part, index) => renderPart(part, `${message.id}-${index}`))}
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
            return (
              <ApprovalCard
                key={part.approval.id}
                approval={approval}
                allowRemember={false}
                onDecide={decision => thread.addToolApprovalResponse({ id: part.approval.id, approved: decision.approve })}
              />
            );
          })}
        </div>
        <form className="vendo-composer vendo-stack" aria-label="Message composer" onSubmit={event => { event.preventDefault(); send(); }}>
          <label>
            <span className="vendo-muted">Message</span>
            <textarea
              className="vendo-input"
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
          <div className="vendo-row">
            <button className="vendo-primary" type="submit" disabled={busy || !draft.trim()}>Send</button>
            {busy ? <button type="button" onClick={() => void thread.stop()}>Stop</button> : null}
            <span role="status" aria-live="polite" className="vendo-muted">{thread.status}</span>
          </div>
        </form>
      </section>
    </ChromeRoot>
  );
}
