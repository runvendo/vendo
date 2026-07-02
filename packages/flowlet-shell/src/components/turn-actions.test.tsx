import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TurnActions } from "./TurnActions";

describe("TurnActions", () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("copies the turn markdown", () => {
    render(<TurnActions text="the answer" />);
    fireEvent.click(screen.getByLabelText("Copy"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("the answer");
  });

  it("regenerates when asked", () => {
    const onRegenerate = vi.fn();
    render(<TurnActions text="x" onRegenerate={onRegenerate} />);
    fireEvent.click(screen.getByLabelText("Regenerate"));
    expect(onRegenerate).toHaveBeenCalledOnce();
  });

  it("shows Retry instead of Regenerate on an errored turn", () => {
    const onRegenerate = vi.fn();
    render(<TurnActions text="x" onRegenerate={onRegenerate} errored />);
    expect(screen.queryByLabelText("Regenerate")).toBeNull();
    fireEvent.click(screen.getByText("Retry"));
    expect(onRegenerate).toHaveBeenCalledOnce();
  });

  it("toggles feedback and forwards the vote", () => {
    const onFeedback = vi.fn();
    render(<TurnActions text="x" onFeedback={onFeedback} />);
    const up = screen.getByLabelText("Good response");
    fireEvent.click(up);
    expect(onFeedback).toHaveBeenCalledWith("up");
    expect(up.getAttribute("aria-pressed")).toBe("true");
    // Re-press toggles off without another forward.
    fireEvent.click(up);
    expect(up.getAttribute("aria-pressed")).toBe("false");
    expect(onFeedback).toHaveBeenCalledTimes(1);
  });

  it("hides feedback controls when no sink is provided", () => {
    render(<TurnActions text="x" />);
    expect(screen.queryByLabelText("Good response")).toBeNull();
  });
});
