import { describe, it, expect } from "vitest";
import type { UINode } from "@vendoai/core";
import { initialVoiceSnapshot, reduceVoice, type VoiceEvent } from "./voice-session";
import { voiceSessionMessages } from "./voice-messages";

const node: UINode = { id: "n1", kind: "component", source: "prewired", name: "Table", props: {} };

const snapshotOf = (events: VoiceEvent[]) => events.reduce(reduceVoice, initialVoiceSnapshot);

describe("voiceSessionMessages", () => {
  it("interleaves transcript and views in session order and folds same-role runs", () => {
    const snap = snapshotOf([
      { type: "caption", id: "u1", role: "user", text: "show my spending", final: true },
      { type: "view", id: "v1", node },
      { type: "caption", id: "a1", role: "assistant", text: "Here it is.", final: true },
      { type: "caption", id: "u2", role: "user", text: "thanks", final: true },
    ]);
    const messages = voiceSessionMessages(snap);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // The assistant turn folds the view + narration into one message, in order.
    expect(messages[1]!.parts.map((p) => p.type)).toEqual(["data-ui", "text"]);
  });

  it("records resolved approvals as a compact trace, never a live card", () => {
    const snap = snapshotOf([
      { type: "approval", id: "a1", toolName: "send_email", input: {}, tier: "act" },
      { type: "approval-resolved", id: "a1", resolution: "voice" },
      { type: "approval", id: "a2", toolName: "transfer_funds", input: {}, tier: "critical" },
      { type: "approval-resolved", id: "a2", resolution: "declined" },
    ]);
    const messages = voiceSessionMessages(snap);
    const texts = messages.flatMap((m) => m.parts).map((p) => (p as { text?: string }).text ?? "");
    expect(texts.join(" ")).toContain("approved by voice");
    expect(texts.join(" ")).toContain("declined");
  });

  it("drops unresolved approvals and empty captions", () => {
    const snap = snapshotOf([
      { type: "caption", id: "u1", role: "user", text: "   ", final: true },
      { type: "approval", id: "a1", toolName: "send_email", input: {}, tier: "act" },
    ]);
    expect(voiceSessionMessages(snap)).toHaveLength(0);
  });
});
