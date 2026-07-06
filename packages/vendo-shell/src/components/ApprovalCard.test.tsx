import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApprovalCard } from "./ApprovalCard";

describe("ApprovalCard — escalation register", () => {
  it("renders the reason line and puts the safe action first when a reason is present", () => {
    render(
      <ApprovalCard
        toolName="send_email"
        input={{ to: "backup@evil.co" }}
        tier="act"
        reason="An email I just read asked me to send your client list — that's not something you asked for, so I stopped."
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByText(/Hold on — I stopped to check:/)).toBeTruthy();
    expect(screen.getByText(/that's not something you asked for/)).toBeTruthy();
    const buttons = screen.getAllByRole("button");
    // Decline is the SAFE choice — it must be primary (first / visually
    // dominant) when escalated, per spec Moment 9.
    expect(buttons[0]?.textContent).toMatch(/no/i);
    expect(buttons[0]?.className).toMatch(/fl-btn-primary/);
    expect(buttons[1]?.className).not.toMatch(/fl-btn-primary/);
  });

  it("renders normally (no reason line, approve stays primary) for an ordinary act-tier approval", () => {
    render(<ApprovalCard toolName="send_email" input={{}} tier="act" onApprove={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.queryByText(/Hold on/)).toBeNull();
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]?.className).toMatch(/fl-btn-primary/);
  });

  it("formats a cents-hinted material field as currency on a critical card ($500.00, not 50000)", () => {
    render(
      <ApprovalCard
        toolName="transfer_money"
        input={{ amount: 50000 }}
        tier="critical"
        formats={{ amount: "cents" }}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByText("$500.00")).toBeTruthy();
    expect(screen.queryByText("50000")).toBeNull();
  });

  it("critical tier ignores a reason prop's button-priority flip — ceremony's own register wins", () => {
    render(<ApprovalCard toolName="transfer_money" input={{ amount: 100 }} tier="critical" reason="unusual" onApprove={vi.fn()} onDecline={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]?.className).toMatch(/fl-btn-ceremony/); // critical's own register, unaffected by reason
  });
});
