import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FadeProposalCard } from "./FadeProposalCard";

describe("FadeProposalCard (ENG-193 §3 Moment 5)", () => {
  it("renders the ordinal from the tracker's own count=3 as 'third'", () => {
    render(<FadeProposalCard toolName="GMAIL_SEND_EMAIL" count={3} onAccept={() => {}} onDecline={() => {}} />);
    expect(screen.getByText(/third time/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /sounds good/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /keep asking/i })).toBeTruthy();
  });

  it("renders count=4 as '4th', not a hardcoded 'third' (review nit)", () => {
    render(<FadeProposalCard toolName="GMAIL_SEND_EMAIL" count={4} onAccept={() => {}} onDecline={() => {}} />);
    expect(screen.getByText(/4th time/i)).toBeTruthy();
    expect(screen.queryByText(/third time/i)).toBeNull();
  });

  it("renders count=21 as '21st' (ordinal suffix rules, not just a 3-special-case)", () => {
    render(<FadeProposalCard toolName="GMAIL_SEND_EMAIL" count={21} onAccept={() => {}} onDecline={() => {}} />);
    expect(screen.getByText(/21st time/i)).toBeTruthy();
  });

  it("falls back to generic copy when count is absent", () => {
    render(<FadeProposalCard toolName="GMAIL_SEND_EMAIL" onAccept={() => {}} onDecline={() => {}} />);
    expect(screen.getByText(/You've okayed this a few times/i)).toBeTruthy();
    expect(screen.queryByText(/third time/i)).toBeNull();
  });

  it("fires onAccept/onDecline", () => {
    const onAccept = vi.fn(), onDecline = vi.fn();
    render(<FadeProposalCard toolName="GMAIL_SEND_EMAIL" count={3} onAccept={onAccept} onDecline={onDecline} />);
    fireEvent.click(screen.getByRole("button", { name: /sounds good/i }));
    fireEvent.click(screen.getByRole("button", { name: /keep asking/i }));
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledOnce();
  });
});
