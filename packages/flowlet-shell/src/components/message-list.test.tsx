import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { type UINode } from "@flowlet/core";
import { createStubAgent } from "@flowlet/core/testing";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import { MessageList } from "./MessageList";
import type { ThreadItem } from "../use-flowlet-thread";

// A GENERATED node: the render_view product that pairs with a skeleton in the
// reveal slot. (Host component nodes now bypass the reveal on purpose.)
const node: UINode = { id: "ui-1", kind: "generated", payload: {} };

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
  it("shows an accessible working indicator during dead air after the user sends", () => {
    const { container } = render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider renderNode={() => <div data-testid="rendered" />}>
          <MessageList
            items={[{ kind: "text", key: "u1", messageId: "m1", role: "user", text: "hi" }]}
            status="submitted"
            onApprove={vi.fn()}
          />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    // First paint is the static-dot fallback; the async fluidkit upgrade is
    // covered by fluid-thinking.test.tsx.
    expect(container.querySelector('[aria-label="Working"]')).toBeTruthy();
  });

  it("keeps one persistent reveal slot across the skeleton→view swap", () => {
    const skeletonItems: ThreadItem[] = [
      { kind: "skeleton", key: "m1:1", messageId: "m1", name: "SpendChart" },
    ];
    const uiItems: ThreadItem[] = [{ kind: "ui", key: "m1:2", messageId: "m1", node }];
    const { container, rerender } = render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider renderNode={() => <div data-testid="rendered" />}>
          <MessageList items={skeletonItems} status="streaming" onApprove={vi.fn()} />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    const slotBefore = container.querySelector(".fl-reveal");
    expect(slotBefore?.getAttribute("data-phase")).toBe("skeleton");
    rerender(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider renderNode={() => <div data-testid="rendered" />}>
          <MessageList items={uiItems} status="ready" onApprove={vi.fn()} />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    const slotAfter = container.querySelector(".fl-reveal");
    expect(slotAfter?.getAttribute("data-phase")).toBe("view");
    // Same DOM node = same React identity: the slot survived the item swap,
    // which is what lets the reveal morph instead of remount.
    expect(slotAfter).toBe(slotBefore);
    expect(screen.getByTestId("ui-node")).toBeTruthy();
  });

  it("renders an error item with friendly copy — raw detail never reaches the DOM", () => {
    const { container } = renderList([
      { kind: "error", key: "e1", messageId: "m", message: "Something exploded" } as unknown as ThreadItem,
    ]);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/try again/i);
    expect(container.innerHTML).not.toContain("Something exploded");
    expect(alert.hasAttribute("title")).toBe(false);
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
