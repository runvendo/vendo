import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createStubAgent, type UINode } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import { ApprovalCard } from "./ApprovalCard";
import { UINodeView } from "./UINodeView";

describe("ApprovalCard", () => {
  it("calls onApprove and onDecline", () => {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    render(<ApprovalCard toolName="budgetCreate" input={{ cap: 2000 }} onApprove={onApprove} onDecline={onDecline} />);
    fireEvent.click(screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Decline"));
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledOnce();
  });
});

describe("UINodeView", () => {
  it("delegates rendering to the shell renderNode", () => {
    const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };
    render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider renderNode={() => <div data-testid="rendered">ok</div>}>
          <UINodeView node={node} />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    expect(screen.getByTestId("rendered")).toBeTruthy();
  });
});
