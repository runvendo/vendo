import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WaitingList, type ParkedActionRow } from "./WaitingList";

const row = (over: Partial<ParkedActionRow> = {}): ParkedActionRow => ({
  id: "parked-1",
  tool: "GMAIL_SEND_EMAIL",
  tier: "act",
  inputPreview: "To: acme@example.com",
  requestedAt: new Date(Date.now() - 60_000).toISOString(),
  ...over,
});

describe("WaitingList", () => {
  it("renders nothing when there are no parked actions", () => {
    const { container } = render(<WaitingList actions={[]} onApprove={vi.fn()} onDecline={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one row per parked action with a friendly label and a relative requested-when", () => {
    render(
      <WaitingList
        actions={[row(), row({ id: "parked-2", tool: "GOOGLECALENDAR_CREATE_EVENT" })]}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByText(/Waiting on you \(2\)/)).toBeTruthy();
    expect(screen.getByText(/Send email/i)).toBeTruthy();
    expect(screen.getAllByText(/ago|just now/i).length).toBeGreaterThan(0);
  });

  it("gives a critical-tier row the ceremony treatment, an act-tier row the plain treatment", () => {
    render(
      <WaitingList
        actions={[row({ id: "parked-crit", tier: "critical" }), row({ id: "parked-act", tier: "act" })]}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.some((b) => b.className.includes("fl-btn-ceremony"))).toBe(true);
    expect(buttons.some((b) => b.className.includes("fl-btn-primary"))).toBe(true);
  });

  it("shows the inputPreview and a guardStale note when the row carries guardStale", () => {
    render(
      <WaitingList
        actions={[row({ inputPreview: "To: staleness@example.com", guardStale: true })]}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByText(/staleness@example.com/)).toBeTruthy();
    expect(screen.getByText(/conditions can't be re-verified/i)).toBeTruthy();
  });

  it("Approve/Decline call the corresponding callback with the action's id", () => {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    render(<WaitingList actions={[row({ id: "parked-9" })]} onApprove={onApprove} onDecline={onDecline} />);
    screen.getByText(/approve/i).click();
    expect(onApprove).toHaveBeenCalledWith("parked-9");
    screen.getByText(/decline/i).click();
    expect(onDecline).toHaveBeenCalledWith("parked-9");
  });
});
