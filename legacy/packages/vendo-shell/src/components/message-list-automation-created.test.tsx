import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createStubAgent } from "@vendoai/core/testing";
import { VendoProvider } from "@vendoai/react";
import { VendoShellProvider } from "../context";
import type { ThreadItem } from "../use-vendo-thread";
import { MessageList } from "./MessageList";
import { AUTOMATION_CREATED_HOLD_MS } from "./AutomationCreatedMorph";

vi.mock("./fluid-motion", () => ({
  loadFluidMotion: () => Promise.resolve(null),
  loadedFluidMotion: () => null,
}));

const receiptSpec = {
  dslVersion: 1,
  name: "Receipt forwarding",
  description: "For larger card charges, find the matching receipt and forward it to accounting.",
  prompt: "Whenever a charge over $75 hits, find the receipt in my email and forward it to receipts@cove.com.",
  trigger: { type: "host_event", event: "transaction.created" },
  if: "trigger.amount > 75",
  execution: {
    mode: "steps",
    steps: [
      { id: "find", type: "tool", tool: "GMAIL_SEARCH_EMAILS", input: { query: "receipt" } },
      { id: "send", type: "tool", tool: "GMAIL_SEND_EMAIL", input: { to: "receipts@cove.com" } },
    ],
  },
};

const userItem: ThreadItem = {
  kind: "text",
  key: "user",
  messageId: "m-user",
  role: "user",
  text: "Whenever a charge over $75 hits, find the receipt in my email and forward it to receipts@cove.com.",
};

const approvalItem: ThreadItem = {
  kind: "approval",
  key: "approval",
  messageId: "m-assistant",
  approvalId: "approval-1",
  toolCallId: "call-1",
  toolName: "create_automation",
  input: { spec: receiptSpec, grantedTools: ["GMAIL_SEARCH_EMAILS", "GMAIL_SEND_EMAIL"] },
};

function renderShell(items: ThreadItem[], onApprove = vi.fn()) {
  return render(
    <VendoProvider agent={createStubAgent()} components={[]}>
      <VendoShellProvider>
        <MessageList items={items} status="ready" onApprove={onApprove} />
      </VendoShellProvider>
    </VendoProvider>,
  );
}

describe("MessageList automation created confirmation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps a top-right running notification after the approval item is removed", async () => {
    const onApprove = vi.fn();
    const { rerender } = renderShell([userItem, approvalItem], onApprove);

    fireEvent.click(screen.getByText("Turn on automation"));
    expect(onApprove).toHaveBeenCalledWith("approval-1");

    rerender(
      <VendoProvider agent={createStubAgent()} components={[]}>
        <VendoShellProvider>
          <MessageList items={[userItem]} status="ready" onApprove={onApprove} />
        </VendoShellProvider>
      </VendoProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const status = screen.getByRole("status", { name: /automation running: receipt forwarding using gmail/i });
    expect(status.textContent).toContain("Automation running");
    expect(status.textContent).toContain("Receipt forwarding");
    expect(status.querySelector(".fl-auto-created-count")?.textContent).toBe("2");

    await act(async () => {
      vi.advanceTimersByTime(AUTOMATION_CREATED_HOLD_MS + 100);
      await Promise.resolve();
    });

    expect(screen.queryByRole("status", { name: /automation running/i })).toBeNull();
  });
});
