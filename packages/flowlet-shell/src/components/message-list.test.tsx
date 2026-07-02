import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { type UINode } from "@flowlet/core";
import { createStubAgent } from "@flowlet/core/testing";
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
  it("renders an error item with friendly copy — raw detail only on the title attr", () => {
    renderList([{ kind: "error", key: "e1", messageId: "m", message: "Something exploded" } as unknown as ThreadItem]);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/try again/i);
    expect(alert.textContent).not.toContain("Something exploded");
    expect(alert.getAttribute("title")).toBe("Something exploded");
  });

  it("renders text, approval, ui items, groups tool calls into an activity panel, and announces via a log", () => {
    const onApprove = vi.fn();
    renderList([
      { kind: "text", key: "a", messageId: "m", role: "assistant", text: "hello" },
      { kind: "tool", key: "b", messageId: "m", toolName: "q", state: "output-available" },
      { kind: "approval", key: "c", messageId: "m", approvalId: "a1", toolName: "budgetCreate", input: {} },
      { kind: "ui", key: "d", messageId: "m", node },
    ], onApprove);
    // A dedicated visually-hidden live region announces the settled assistant turn,
    // so the assistant text appears both in the bubble and (atomically) in the log.
    expect(screen.getByRole("log")).toBeTruthy();
    expect(screen.getAllByText("hello").length).toBeGreaterThan(0);
    // Non-render tool calls are grouped into one collapsible activity panel
    // (render_view/request_connect never reach here — they stay a skeleton).
    expect(screen.getByTestId("activity-panel")).toBeTruthy();
    expect(screen.getByTestId("ui-node")).toBeTruthy();
    fireEvent.click(screen.getByText("Approve"));
    expect(onApprove).toHaveBeenCalledWith("a1");
  });
});
