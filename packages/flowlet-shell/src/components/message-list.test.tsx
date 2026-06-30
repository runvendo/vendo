import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createStubAgent, type UINode } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import { MessageList } from "./MessageList";
import type { ThreadItem } from "../use-flowlet-thread";

const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };

function renderList(items: ThreadItem[], onApprove = vi.fn()) {
  return render(
    <FlowletProvider agent={createStubAgent()} components={[]}>
      <FlowletShellProvider renderNode={() => <div data-testid="rendered" />}>
        <MessageList items={items} status="ready" onApprove={onApprove} />
      </FlowletShellProvider>
    </FlowletProvider>,
  );
}

describe("MessageList", () => {
  it("renders text, tool, approval, and ui items, and is a log", () => {
    const onApprove = vi.fn();
    renderList([
      { kind: "text", key: "a", role: "assistant", text: "hello" },
      { kind: "tool", key: "b", toolName: "q", state: "output-available" },
      { kind: "approval", key: "c", approvalId: "a1", toolName: "budgetCreate", input: {} },
      { kind: "ui", key: "d", node },
    ], onApprove);
    expect(screen.getByRole("log")).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByTestId("tool-call")).toBeTruthy();
    expect(screen.getByTestId("ui-node")).toBeTruthy();
    fireEvent.click(screen.getByText("Approve"));
    expect(onApprove).toHaveBeenCalledWith("a1");
  });
});
