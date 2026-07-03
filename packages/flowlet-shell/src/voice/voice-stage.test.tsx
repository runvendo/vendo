import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { FlowletShellProvider } from "../context";
import { VoiceStage } from "./VoiceStage";
import { initialVoiceSnapshot, reduceVoice, type VoiceEvent, type VoiceSnapshot } from "./voice-session";
import { createScriptedVoiceDriver } from "./scripted-driver";

const snapshotOf = (events: VoiceEvent[]): VoiceSnapshot => events.reduce(reduceVoice, initialVoiceSnapshot);

const noop = () => {};

function renderStage(snapshot: VoiceSnapshot, overrides: Partial<Parameters<typeof VoiceStage>[0]> = {}) {
  return render(
    <FlowletShellProvider store={undefined as never}>
      <VoiceStage
        snapshot={snapshot}
        onMute={noop}
        onEnd={noop}
        onApprove={noop}
        onDecline={noop}
        onClosed={noop}
        {...overrides}
      />
    </FlowletShellProvider>,
  );
}

describe("VoiceStage", () => {
  it("announces the session status and pins the blob head", () => {
    renderStage(snapshotOf([{ type: "status", status: "listening" }]));
    expect(screen.getByText("Listening")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Voice session" })).toBeTruthy();
  });

  it("shows Muted over live statuses when muted", () => {
    renderStage(snapshotOf([{ type: "status", status: "listening" }, { type: "muted", muted: true }]));
    expect(screen.getByText("Muted")).toBeTruthy();
  });

  it("renders act-tier approvals tappable and their voice-approved receipt", () => {
    const onApprove = vi.fn();
    const pending = snapshotOf([
      { type: "status", status: "listening" },
      { type: "approval", id: "a1", toolName: "send_email", input: { to: "x@y.co" }, tier: "act" },
    ]);
    const { rerender } = renderStage(pending, { onApprove });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledWith("a1", "tap");

    const settled = reduceVoice(pending, { type: "approval-resolved", id: "a1", resolution: "voice" });
    rerender(
      <FlowletShellProvider store={undefined as never}>
        <VoiceStage snapshot={settled} onMute={noop} onEnd={noop} onApprove={onApprove} onDecline={noop} onClosed={noop} />
      </FlowletShellProvider>,
    );
    expect(screen.getByText(/approved by voice/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("renders critical approvals with the named confirm and consequence line", () => {
    renderStage(
      snapshotOf([
        { type: "approval", id: "a2", toolName: "transfer_funds", input: { amount: 5000 }, tier: "critical" },
      ]),
    );
    expect(screen.getByText("Confirm on screen")).toBeTruthy();
    expect(screen.getByText("This can't be undone.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Confirm — / })).toBeTruthy();
  });

  it("shows the live caption and the reconnect banner", () => {
    renderStage(
      snapshotOf([
        { type: "caption", id: "c1", role: "assistant", text: "checking your calendar" },
        { type: "status", status: "reconnecting" },
      ]),
    );
    expect(screen.getByText("checking your calendar")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("opens the transcript drawer with finished lines", () => {
    renderStage(
      snapshotOf([{ type: "caption", id: "c1", role: "user", text: "show my spending", final: true }]),
    );
    fireEvent.click(screen.getByRole("button", { name: /transcript/ }));
    expect(screen.getByText("show my spending")).toBeTruthy();
  });

  it("closes the transcript drawer when an approval arrives (consent is never covered)", () => {
    const before = snapshotOf([{ type: "caption", id: "c1", role: "user", text: "hi", final: true }]);
    const { rerender } = renderStage(before);
    fireEvent.click(screen.getByRole("button", { name: /transcript/ }));
    expect(screen.getByText("hi")).toBeTruthy(); // drawer open
    const withApproval = reduceVoice(before, {
      type: "approval", id: "a1", toolName: "send_email", input: {}, tier: "act",
    });
    rerender(
      <FlowletShellProvider store={undefined as never}>
        <VoiceStage snapshot={withApproval} onMute={noop} onEnd={noop} onApprove={noop} onDecline={noop} onClosed={noop} />
      </FlowletShellProvider>,
    );
    expect(screen.queryByText("hi")).toBeNull(); // drawer yielded to the consent card
  });

  it("fires onClosed after the exit beat when the session ends", () => {
    vi.useFakeTimers();
    const onClosed = vi.fn();
    renderStage(snapshotOf([{ type: "status", status: "ended" }]), { onClosed });
    expect(onClosed).not.toHaveBeenCalled();
    act(() => {
      vi.runAllTimers();
    });
    expect(onClosed).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

describe("createScriptedVoiceDriver", () => {
  it("plays beats in order and lets a tap beat the armed auto-yes", async () => {
    vi.useFakeTimers();
    const events: VoiceEvent[] = [];
    const driver = createScriptedVoiceDriver(
      [
        { event: { type: "status", status: "listening" } },
        { event: { type: "approval", id: "a1", toolName: "send_email", input: {}, tier: "act" } },
        { autoVoiceYes: { id: "a1", after: 2000, sayText: "yes send it" } },
        { waitApproval: "a1" },
        { event: { type: "status", status: "ended" } },
      ],
      { timeScale: 1 },
    );
    const handle = driver.start((e) => events.push(e));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    // Tap before the simulated spoken yes lands.
    handle.approve("a1", "tap");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const resolutions = events.filter((e) => e.type === "approval-resolved");
    expect(resolutions).toEqual([{ type: "approval-resolved", id: "a1", resolution: "tap" }]);
    expect(events.at(-1)).toMatchObject({ type: "status", status: "ended" });
    handle.stop();
    vi.useRealTimers();
  });
});
