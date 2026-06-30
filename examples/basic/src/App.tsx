import type { ComponentType } from "react";
import { z } from "zod";
import { createStubAgent, type FlowletUIMessage } from "@flowlet/core";
import { FlowletProvider, useFlowletChat, StubRenderer } from "@flowlet/react";
import { DemoCard } from "./components";

const agent = createStubAgent();
const components = [
  { name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" as const },
];

const impls: Record<string, ComponentType<Record<string, unknown>>> = {
  DemoCard: DemoCard as ComponentType<Record<string, unknown>>,
};

type FlowletPart = FlowletUIMessage["parts"][number];

function Chat() {
  const chat = useFlowletChat();
  const parts = chat.messages.flatMap((m) => m.parts);
  // Native ai SDK tool part in the approval-requested state. Its `tool-${string}`
  // discriminant can't be Extract-narrowed to a literal, so cast the matched part.
  const approval = parts.find(
    (p) => p.type === "tool-renderDemoCard" && (p as { state?: string }).state === "approval-requested",
  ) as { approval: { id: string } } | undefined;
  // Our custom data-ui node, emitted by the approved tool's execution.
  const uiNode = parts.find(
    (p): p is Extract<FlowletPart, { type: "data-ui" }> => p.type === "data-ui",
  );
  const text = parts
    .filter((p): p is Extract<FlowletPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");

  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 480, margin: "40px auto" }}>
      <button onClick={() => chat.sendMessage({ text: "show me a card" })}>Send</button>
      {text && <p>{text}</p>}
      {approval && (
        <button onClick={() => chat.addToolApprovalResponse({ id: approval.approval.id, approved: true })}>
          Approve rendering the demo card
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
