import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent, type UINode } from "@flowlet/core";
import { z } from "zod";
import { FlowletProvider } from "./provider";
import { useFlowletChat } from "./use-flowlet-chat";
import { StubRenderer } from "./stub-renderer";

function DemoCard({ title }: { title: string }) {
  return <div data-testid="demo-card">{title}</div>;
}

function Harness() {
  const chat = useFlowletChat();
  const parts = chat.messages.flatMap((m) => m.parts) as any[];
  // Native ai SDK tool part in the approval-requested state.
  const approval = parts.find(
    (p) => p.type === "tool-renderDemoCard" && p.state === "approval-requested",
  );
  // Our custom data-ui node, emitted by the approved tool's execution.
  const uiNode = parts.find((p) => p.type === "data-ui") as { data: UINode } | undefined;

  return (
    <div>
      <button onClick={() => chat.sendMessage({ text: "show me a card" })}>send</button>
      {approval && (
        <button
          data-testid="approve"
          onClick={() => chat.addToolApprovalResponse({ id: approval.approval.id, approved: true })}
        >
          approve
        </button>
      )}
      {uiNode && <StubRenderer node={uiNode.data} impls={{ DemoCard }} />}
    </div>
  );
}

describe("end-to-end native HITL loop", () => {
  it("send -> approval-requested -> approve -> renders the DemoCard node", async () => {
    render(
      <FlowletProvider
        agent={createStubAgent()}
        components={[
          { name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" },
        ]}
      >
        <Harness />
      </FlowletProvider>,
    );

    fireEvent.click(screen.getByText("send"));
    await waitFor(() => screen.getByTestId("approve"));
    fireEvent.click(screen.getByTestId("approve"));
    await waitFor(() => screen.getByTestId("demo-card"));
    expect(screen.getByTestId("demo-card").textContent).toBe("Hello from Flowlet");
  });
});
