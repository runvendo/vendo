import { describe, it, expect } from "vitest";
import type { UINode } from "@flowlet/core";
import { initialVoiceSnapshot, reduceVoice, type VoiceSnapshot } from "./voice-session";

const node: UINode = { id: "n1", kind: "component", source: "prewired", name: "Table", props: {} };

const run = (events: Parameters<typeof reduceVoice>[1][]): VoiceSnapshot =>
  events.reduce(reduceVoice, initialVoiceSnapshot);

describe("reduceVoice", () => {
  it("streams a caption live, then finalizes it into the transcript", () => {
    let snap = run([
      { type: "status", status: "listening" },
      { type: "caption", id: "c1", role: "user", text: "show me" },
    ]);
    expect(snap.live?.text).toBe("show me");
    expect(snap.transcript).toHaveLength(0);
    snap = reduceVoice(snap, { type: "caption", id: "c1", role: "user", text: "show me spending", final: true });
    expect(snap.live).toBeUndefined();
    expect(snap.transcript).toEqual([
      { id: "c1", role: "user", text: "show me spending", interrupted: undefined, seq: 0 },
    ]);
  });

  it("replaces a pending view in place so the reveal morphs instead of appending", () => {
    const snap = run([
      { type: "view-pending", id: "v1", name: "Table" },
      { type: "caption", id: "c1", role: "assistant", text: "here", final: true },
      { type: "view", id: "v1", node },
    ]);
    expect(snap.feed).toHaveLength(1);
    expect(snap.feed[0]).toMatchObject({ kind: "view", id: "v1", seq: 0 });
    // The view keeps its pending slot's seq — it lands BEFORE the caption.
    expect(snap.transcript[0]!.seq).toBe(1);
  });

  it("resolves approvals in place and keeps deny sticky", () => {
    let snap = run([{ type: "approval", id: "a1", toolName: "send_email", input: { to: "x" }, tier: "act" }]);
    snap = reduceVoice(snap, { type: "approval-resolved", id: "a1", resolution: "voice" });
    expect(snap.feed[0]).toMatchObject({ kind: "approval", resolution: "voice" });
  });

  it("zeroes amplitude when muted and on non-live statuses", () => {
    let snap = run([
      { type: "status", status: "speaking" },
      { type: "amplitude", value: 0.8 },
    ]);
    expect(snap.amplitude).toBe(0.8);
    snap = reduceVoice(snap, { type: "muted", muted: true });
    expect(snap.amplitude).toBe(0);
    snap = run([
      { type: "status", status: "speaking" },
      { type: "amplitude", value: 0.6 },
      { type: "status", status: "thinking" },
    ]);
    expect(snap.amplitude).toBe(0);
  });

  it("marks interrupted captions", () => {
    const snap = run([
      { type: "caption", id: "c1", role: "assistant", text: "as I was say", final: true, interrupted: true },
    ]);
    expect(snap.transcript[0]!.interrupted).toBe(true);
  });
});
