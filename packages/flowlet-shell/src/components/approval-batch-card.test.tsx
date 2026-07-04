import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApprovalBatchCard } from "./ApprovalBatchCard";
import type { ThreadItem } from "../use-flowlet-thread";

const items = [
  { kind: "approval", key: "a1", messageId: "m", approvalId: "ap1", toolCallId: "c1", toolName: "GMAIL_SEND_EMAIL", input: { to: "a@x.com" } },
  { kind: "approval", key: "a2", messageId: "m", approvalId: "ap2", toolCallId: "c2", toolName: "GMAIL_SEND_EMAIL", input: { to: "b@x.com" } },
] as Extract<ThreadItem, { kind: "approval" }>[];

describe("ApprovalBatchCard", () => {
  it("shows 'Approve all N' / 'Pick which' / 'No'", () => {
    render(<ApprovalBatchCard toolName="GMAIL_SEND_EMAIL" items={items} onApproveAll={vi.fn()} onApproveSubset={vi.fn()} onDeclineAll={vi.fn()} />);
    expect(screen.getByText("Approve all 2")).toBeTruthy();
    expect(screen.getByText("Pick which…")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
  });

  it("Approve all calls onApproveAll with every approvalId", () => {
    const onApproveAll = vi.fn();
    render(<ApprovalBatchCard toolName="GMAIL_SEND_EMAIL" items={items} onApproveAll={onApproveAll} onApproveSubset={vi.fn()} onDeclineAll={vi.fn()} />);
    fireEvent.click(screen.getByText("Approve all 2"));
    expect(onApproveAll).toHaveBeenCalledWith(["ap1", "ap2"], ["c1", "c2"]);
  });

  it("Pick which expands checkboxes; unchecking one and confirming calls onApproveSubset", () => {
    const onApproveSubset = vi.fn();
    render(<ApprovalBatchCard toolName="GMAIL_SEND_EMAIL" items={items} onApproveAll={vi.fn()} onApproveSubset={onApproveSubset} onDeclineAll={vi.fn()} />);
    fireEvent.click(screen.getByText("Pick which…"));
    fireEvent.click(screen.getByLabelText(/b@x\.com/));
    fireEvent.click(screen.getByText("Approve selected"));
    expect(onApproveSubset).toHaveBeenCalledWith(["ap1"], ["c1"], ["c1", "c2"]);
  });

  it("No calls onDeclineAll with every approvalId", () => {
    const onDeclineAll = vi.fn();
    render(<ApprovalBatchCard toolName="GMAIL_SEND_EMAIL" items={items} onApproveAll={vi.fn()} onApproveSubset={vi.fn()} onDeclineAll={onDeclineAll} />);
    fireEvent.click(screen.getByText("No"));
    expect(onDeclineAll).toHaveBeenCalledWith(["ap1", "ap2"]);
  });
});
