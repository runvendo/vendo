import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent, type FlowletUIMessage } from "@flowlet/core";
import { z } from "zod";
import { FlowletProvider } from "./provider";
import { useFlowletChat } from "./use-flowlet-chat";
import { StubRenderer } from "./stub-renderer";

type FlowletPart = FlowletUIMessage["parts"][number];

function DemoCard({ title }: { title: string }) {
  return <div data-testid="demo-card">{title}</div>;
}

function Harness() {
  const chat = useFlowletChat();
  const [answered, setAnswered] = useState(false);
  const parts = chat.messages.flatMap((m: FlowletUIMessage) => m.parts);
  const approval = parts.find(
    (p): p is Extract<FlowletPart, { type: "data-approval" }> => p.type === "data-approval",
  );
  const uiNode = parts.find(
    (p): p is Extract<FlowletPart, { type: "data-ui" }> => p.type === "data-ui",
  );

  return (
    <div>
      <button onClick={() => chat.sendMessage({ text: "hi" })}>send</button>
      {approval && !answered && (
        <button
          data-testid="approve"
          onClick={() => {
            setAnswered(true);
            chat.respondToApproval(approval.data.approvalId, true);
          }}
        >
          approve
        </button>
      )}
      {uiNode && <StubRenderer node={uiNode.data} impls={{ DemoCard }} />}
    </div>
  );
}

describe("end-to-end stub loop", () => {
  it("streams text -> approval -> approve -> renders the component node", async () => {
    render(
      <FlowletProvider
        agent={createStubAgent()}
        components={[{ name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" }]}
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
