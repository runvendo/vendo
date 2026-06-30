import { z } from "zod";
import { createStubAgent, type FlowletUIMessage } from "@flowlet/core";
import { FlowletProvider, useFlowletChat, FlowletStage } from "@flowlet/react";
import { createExampleAgent } from "./realAgent";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const agent = createStubAgent();
const realAgent = createExampleAgent();

const components = [
  {
    name: "DemoCard",
    description: "a demo card",
    propsSchema: z.object({ title: z.string() }),
    source: "prewired" as const,
  },
];

type FlowletPart = FlowletUIMessage["parts"][number];

// ---------------------------------------------------------------------------
// Stub-agent chat (F1 — requires manual approval)
// ---------------------------------------------------------------------------

function Chat() {
  const chat = useFlowletChat();
  const parts = chat.messages.flatMap((m) => m.parts);
  // Native ai SDK tool part in the approval-requested state. Its `tool-${string}`
  // discriminant can't be Extract-narrowed to a literal, so cast the matched part.
  const approval = parts.find(
    (p) =>
      p.type === "tool-renderDemoCard" &&
      (p as { state?: string }).state === "approval-requested",
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
        <button
          onClick={() =>
            chat.addToolApprovalResponse({ id: approval.approval.id, approved: true })
          }
        >
          Approve rendering the demo card
        </button>
      )}
      {uiNode && <FlowletStage node={uiNode.data} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Real-agent chat (F2 — policy auto-allows the render_ui tool, no prompt)
// ---------------------------------------------------------------------------

function RealChat() {
  const chat = useFlowletChat();
  const parts = chat.messages.flatMap((m) => m.parts);
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
      {uiNode && <FlowletStage node={uiNode.data} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function App() {
  return (
    <div>
      <h2 style={{ fontFamily: "system-ui", textAlign: "center" }}>Stub agent (F1)</h2>
      <FlowletProvider agent={agent} components={components}>
        <Chat />
      </FlowletProvider>

      <hr />

      <h2 style={{ fontFamily: "system-ui", textAlign: "center" }}>Real agent (offline)</h2>
      <FlowletProvider agent={realAgent} components={components}>
        <RealChat />
      </FlowletProvider>
    </div>
  );
}
