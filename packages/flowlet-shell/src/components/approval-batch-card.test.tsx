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

  it("picker rows summarize identity + snippet from host-tool inputs and never expose raw toolCallIds (live-verification polish 2026-07-04)", () => {
    // The live sendClientMessage batch: input {id, body: {body}} summarized to
    // "" — all 8 rows read identically and the a11y label was the toolCallId.
    const hostItems = [
      { kind: "approval", key: "h1", messageId: "m", approvalId: "hp1", toolCallId: "hc1", toolName: "sendClientMessage",
        input: { id: "cl_rivera", body: { body: "Hi Marisol, your documents are due" } } },
      { kind: "approval", key: "h2", messageId: "m", approvalId: "hp2", toolCallId: "hc2", toolName: "sendClientMessage",
        input: { id: "cl_chen", body: { body: "Hi Wei, your documents are due" } } },
    ] as Extract<ThreadItem, { kind: "approval" }>[];
    render(<ApprovalBatchCard toolName="sendClientMessage" items={hostItems} onApproveAll={vi.fn()} onApproveSubset={vi.fn()} onDeclineAll={vi.fn()} />);
    fireEvent.click(screen.getByText("Pick which…"));
    expect(screen.getByLabelText(/cl_rivera — Hi Marisol/)).toBeTruthy();
    expect(screen.getByLabelText(/cl_chen — Hi Wei/)).toBeTruthy();
    expect(screen.queryByLabelText(/hc1/)).toBeNull();
  });

  it("an unidentifiable input gets a positional a11y label, never the toolCallId", () => {
    const blank = [
      { kind: "approval", key: "b1", messageId: "m", approvalId: "bp1", toolCallId: "bc1", toolName: "GMAIL_SEND_EMAIL", input: {} },
      { kind: "approval", key: "b2", messageId: "m", approvalId: "bp2", toolCallId: "bc2", toolName: "GMAIL_SEND_EMAIL", input: {} },
    ] as Extract<ThreadItem, { kind: "approval" }>[];
    render(<ApprovalBatchCard toolName="GMAIL_SEND_EMAIL" items={blank} onApproveAll={vi.fn()} onApproveSubset={vi.fn()} onDeclineAll={vi.fn()} />);
    fireEvent.click(screen.getByText("Pick which…"));
    expect(screen.getByLabelText("Send email 1 of 2")).toBeTruthy();
    expect(screen.queryByLabelText(/bc1/)).toBeNull();
  });

  it("No calls onDeclineAll with every approvalId", () => {
    const onDeclineAll = vi.fn();
    render(<ApprovalBatchCard toolName="GMAIL_SEND_EMAIL" items={items} onApproveAll={vi.fn()} onApproveSubset={vi.fn()} onDeclineAll={onDeclineAll} />);
    fireEvent.click(screen.getByText("No"));
    expect(onDeclineAll).toHaveBeenCalledWith(["ap1", "ap2"]);
  });
});
