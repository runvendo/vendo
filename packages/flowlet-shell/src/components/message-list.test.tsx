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
  it("renders an error item with role alert and message text", () => {
    renderList([{ kind: "error", key: "e1", message: "Something exploded" } as unknown as ThreadItem]);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something exploded")).toBeTruthy();
  });

  it("renders text, approval, ui items, surfaces tool chips, and announces via a log", () => {
    const onApprove = vi.fn();
    renderList([
      { kind: "text", key: "a", role: "assistant", text: "hello" },
      { kind: "tool", key: "b", toolName: "q", state: "output-available" },
      { kind: "approval", key: "c", approvalId: "a1", toolName: "budgetCreate", input: {} },
      { kind: "ui", key: "d", node },
    ], onApprove);
    // A dedicated visually-hidden live region announces the settled assistant turn,
    // so the assistant text appears both in the bubble and (atomically) in the log.
    expect(screen.getByRole("log")).toBeTruthy();
    expect(screen.getAllByText("hello").length).toBeGreaterThan(0);
    // Non-render_ui tool calls surface as a quiet chip (render_ui stays a skeleton).
    expect(screen.getByTestId("tool-call")).toBeTruthy();
    expect(screen.getByTestId("ui-node")).toBeTruthy();
    fireEvent.click(screen.getByText("Approve"));
    expect(onApprove).toHaveBeenCalledWith("a1");
  });
});
