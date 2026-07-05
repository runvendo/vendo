import React, { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createStubAgent } from "../../../packages/flowlet-core/src/stub-agent";
import { FlowletProvider } from "../../../packages/flowlet-react/src/index";
import "../../../packages/flowlet-shell/src/styles.css";
import { FlowletShellProvider } from "../../../packages/flowlet-shell/src/context";
import { MessageList } from "../../../packages/flowlet-shell/src/components/MessageList";
import type { ThreadItem } from "../../../packages/flowlet-shell/src/use-flowlet-thread";
import "./preview.css";

const receiptSpec = {
  dslVersion: 1,
  name: "Receipt forwarding",
  description: "For larger card charges, find the matching receipt and forward it to accounting.",
  prompt: "Whenever a charge over $75 hits, find the receipt in my email and forward it to receipts@cove.com.",
  trigger: { type: "host_event", event: "transaction.created" },
  if: "trigger.amount > 75",
  execution: {
    mode: "steps",
    steps: [
      {
        id: "find-receipt",
        type: "tool",
        tool: "GMAIL_SEARCH_EMAILS",
        input: {
          query: "from receipts around {{ trigger.merchant }} {{ trigger.amount }}",
        },
      },
      {
        id: "forward-receipt",
        type: "tool",
        tool: "GMAIL_SEND_EMAIL",
        input: {
          to: "receipts@cove.com",
          subject: "Receipt for {{ trigger.merchant }}",
        },
      },
    ],
  },
} as const;

const userItem: ThreadItem = {
  kind: "text",
  key: "user-rule",
  messageId: "message-user",
  role: "user",
  text: "Whenever a charge over $75 hits, find the receipt in my email and forward it to receipts@cove.com.",
};

const approvalItem: ThreadItem = {
  kind: "approval",
  key: "automation-approval",
  messageId: "message-assistant",
  approvalId: "approval-receipts",
  toolCallId: "call-receipts",
  toolName: "create_automation",
  input: { spec: receiptSpec, grantedTools: ["GMAIL_SEARCH_EMAILS", "GMAIL_SEND_EMAIL"] },
};

function threadItems(approved: boolean): ThreadItem[] {
  return approved ? [userItem] : [userItem, approvalItem];
}

function PreviewApp() {
  const [approved, setApproved] = useState(false);
  const [items, setItems] = useState<ThreadItem[]>(() => threadItems(false));

  useEffect(() => {
    setItems(threadItems(approved));
  }, [approved]);

  const replay = () => {
    setApproved(false);
    window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>(".preview-flowlet .fl-btn-primary")?.click();
    }, 360);
  };

  const backToProposal = () => {
    setApproved(false);
  };

  return (
    <main className="real-preview" data-phase={approved ? "approved" : "proposal"} aria-label="Real Flowlet automation card preview">
      <section className="preview-host" aria-label="Cove banking workspace">
        <div className="preview-host-bar">
          <div>
            <h1>Cove operating account</h1>
            <p>Real Flowlet shell component, shown over a restrained host surface.</p>
          </div>
          <div className="preview-host-actions">
            <button type="button" onClick={backToProposal}>Show proposal</button>
            <button type="button" onClick={replay}>Play animation</button>
          </div>
        </div>
        <div className="preview-ledger" aria-label="Transactions">
          {[
            ["Today", "Vercel", "$24.00", false],
            ["Today", "Atlas Supply Co.", "$92.18", true],
            ["Yesterday", "Figma", "$15.00", false],
            ["Jul 3", "Paper Trail", "$41.80", false],
          ].map(([date, merchant, amount, hot]) => (
            <div className={`preview-ledger-row ${hot ? "is-hot" : ""}`} key={`${date}-${merchant}`}>
              <span>{date}</span>
              <strong>{merchant}</strong>
              <span>{amount}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="flowlet-root preview-flowlet" aria-label="Flowlet thread">
        <div className="fl-thread">
          <FlowletProvider agent={createStubAgent()} components={[]}>
            <FlowletShellProvider>
              <MessageList
                items={items}
                status="ready"
                onApprove={() => setApproved(true)}
                onDecline={() => setApproved(false)}
              />
            </FlowletShellProvider>
          </FlowletProvider>
          <div className="preview-composer">
            <span>Ask Flowlet anything...</span>
            <button type="button">Send</button>
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PreviewApp />
  </StrictMode>,
);
