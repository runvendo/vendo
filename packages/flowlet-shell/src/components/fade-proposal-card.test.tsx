import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FadeProposalCard } from "./FadeProposalCard";

describe("FadeProposalCard (ENG-193 §3 Moment 5)", () => {
  it("renders the proposal copy and both actions", () => {
    render(<FadeProposalCard toolName="GMAIL_SEND_EMAIL" onAccept={() => {}} onDecline={() => {}} />);
    expect(screen.getByText(/third time/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /sounds good/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /keep asking/i })).toBeTruthy();
  });
  it("fires onAccept/onDecline", () => {
    const onAccept = vi.fn(), onDecline = vi.fn();
    render(<FadeProposalCard toolName="GMAIL_SEND_EMAIL" onAccept={onAccept} onDecline={onDecline} />);
    fireEvent.click(screen.getByRole("button", { name: /sounds good/i }));
    fireEvent.click(screen.getByRole("button", { name: /keep asking/i }));
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledOnce();
  });
});
