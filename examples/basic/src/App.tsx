import type { ComponentType } from "react";
import { z } from "zod";
import { createStubAgent, type ApprovalRequest, type UINode } from "@flowlet/core";
import { FlowletProvider, useFlowletChat, StubRenderer } from "@flowlet/react";
import { DemoCard } from "./components";

const agent = createStubAgent();
const components = [
  { name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" as const },
];

const impls: Record<string, ComponentType<Record<string, unknown>>> = {
  DemoCard: DemoCard as ComponentType<Record<string, unknown>>,
};

function Chat() {
  const chat = useFlowletChat();
  const parts = chat.messages.flatMap((m) => m.parts);
  const approval = parts.find((p) => p.type === "data-approval") as
    | { data: ApprovalRequest }
    | undefined;
  const uiNode = parts.find((p) => p.type === "data-ui") as { data: UINode } | undefined;
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");

  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 480, margin: "40px auto" }}>
      <button onClick={() => chat.sendMessage({ text: "show me a card" })}>Send</button>
      {text && <p>{text}</p>}
      {approval && (
        <button onClick={() => chat.respondToApproval(approval.data.approvalId, true)}>
          Approve: {approval.data.prompt}
        </button>
      )}
      {uiNode && <StubRenderer node={uiNode.data} impls={impls} />}
    </div>
  );
}

export function App() {
  return (
    <FlowletProvider agent={agent} components={components}>
      <Chat />
    </FlowletProvider>
  );
}
