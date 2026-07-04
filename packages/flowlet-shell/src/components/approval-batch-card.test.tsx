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
    expect(onApproveSubset).toHaveBeenCalledWith(["ap1"], ["c1"], ["ap1", "ap2"], ["c1", "c2"]);
  });

  it("REGRESSION: siblings that stream in after mount stay checked by default (live-verification 2026-07-04)", () => {
    // The batch card mounts as soon as the FIRST siblings appear; the rest
    // stream in afterwards. A checked set seeded once at mount excluded the
    // late arrivals — an untouched "Approve selected" approved the first 2
    // and DECLINED the other 6 in the live run.
    const onApproveSubset = vi.fn();
    const many = Array.from({ length: 8 }, (_, i) => ({
      kind: "approval", key: `k${i}`, messageId: "m", approvalId: `ap${i}`,
      toolCallId: `c${i}`, toolName: "GMAIL_SEND_EMAIL", input: { to: `${i}@x.com` },
    })) as Extract<ThreadItem, { kind: "approval" }>[];
    const { rerender } = render(
      <ApprovalBatchCard toolName="GMAIL_SEND_EMAIL" items={many.slice(0, 2)} onApproveAll={vi.fn()} onApproveSubset={onApproveSubset} onDeclineAll={vi.fn()} />,
    );
    rerender(
      <ApprovalBatchCard toolName="GMAIL_SEND_EMAIL" items={many} onApproveAll={vi.fn()} onApproveSubset={onApproveSubset} onDeclineAll={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Pick which…"));
    fireEvent.click(screen.getByText("Approve selected"));
    expect(onApproveSubset).toHaveBeenCalledWith(
      many.map((i) => i.approvalId),
      many.map((i) => i.toolCallId),
      many.map((i) => i.approvalId),
      many.map((i) => i.toolCallId),
    );
  });

  it("No calls onDeclineAll with every approvalId", () => {
    const onDeclineAll = vi.fn();
    render(<ApprovalBatchCard toolName="GMAIL_SEND_EMAIL" items={items} onApproveAll={vi.fn()} onApproveSubset={vi.fn()} onDeclineAll={onDeclineAll} />);
    fireEvent.click(screen.getByText("No"));
    expect(onDeclineAll).toHaveBeenCalledWith(["ap1", "ap2"]);
  });
});
