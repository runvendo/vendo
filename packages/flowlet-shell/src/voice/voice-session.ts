import type { UINode } from "@flowlet/core";

/**
 * Voice session model (ENG-185). The stage renders a `VoiceSnapshot`; a
 * `VoiceDriver` produces the event stream that builds it. The scripted driver
 * (demo/tests) and the future realtime WebRTC driver implement the same
 * contract, so the whole UI is exercisable without a realtime backend.
 */

export type VoiceStatus =
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "reconnecting"
  | "error"
  | "ended";

/** One caption line — the transcript is a list of these. */
export interface VoiceLine {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Barge-in cut this line short (rendered "— interrupted"). */
  interrupted?: boolean;
  /** Ordering across transcript + feed when the session lands in the thread. */
  seq: number;
}

export type ApprovalTier = "act" | "critical";
export type ApprovalResolution = "voice" | "tap" | "declined";

export type VoiceFeedEntry =
  | { kind: "pending-view"; id: string; name?: string; seq: number }
  | { kind: "view"; id: string; node: UINode; seq: number }
  | {
      kind: "approval";
      id: string;
      toolName: string;
      input: unknown;
      tier: ApprovalTier;
      resolution?: ApprovalResolution;
      seq: number;
    };

export interface VoiceSnapshot {
  status: VoiceStatus;
  muted: boolean;
  /** 0..1 live level (mic while listening, agent output while speaking). */
  amplitude: number;
  /** In-flight captions, ONE SLOT PER ROLE — in real sessions transcription
   *  lags and the two sides interleave; a single slot makes them clobber
   *  each other (found in the real-speech E2E). */
  liveUser?: Omit<VoiceLine, "seq">;
  liveAgent?: Omit<VoiceLine, "seq">;
  transcript: VoiceLine[];
  feed: VoiceFeedEntry[];
  /** Friendly copy for the reconnect/error banner. */
  errorMessage?: string;
  seq: number;
}

export const initialVoiceSnapshot: VoiceSnapshot = {
  status: "connecting",
  muted: false,
  amplitude: 0,
  transcript: [],
  feed: [],
  seq: 0,
};

export type VoiceEvent =
  | { type: "status"; status: VoiceStatus; message?: string }
  | { type: "amplitude"; value: number }
  | { type: "caption"; id: string; role: "user" | "assistant"; text: string; final?: boolean; interrupted?: boolean }
  | { type: "view-pending"; id: string; name?: string }
  | { type: "view"; id: string; node: UINode }
  | { type: "approval"; id: string; toolName: string; input: unknown; tier: ApprovalTier }
  | { type: "approval-resolved"; id: string; resolution: ApprovalResolution }
  | { type: "muted"; muted: boolean };

export function reduceVoice(snap: VoiceSnapshot, event: VoiceEvent): VoiceSnapshot {
  switch (event.type) {
    case "status":
      return {
        ...snap,
        status: event.status,
        errorMessage: event.message ?? (event.status === "reconnecting" || event.status === "error" ? snap.errorMessage : undefined),
        // A frozen blob mid-drop reads as broken; zero the level on non-live states.
        amplitude: event.status === "listening" || event.status === "speaking" ? snap.amplitude : 0,
      };
    case "amplitude":
      return { ...snap, amplitude: Math.max(0, Math.min(1, event.value)) };
    case "caption": {
      const slot = event.role === "user" ? "liveUser" : "liveAgent";
      const prior = snap[slot];
      // NEVER lose words: a new utterance arriving while a different one is
      // still un-finalized promotes the old line into the transcript instead
      // of silently replacing it (missing `completed` events happen).
      let transcript = snap.transcript;
      let seq = snap.seq;
      if (prior && prior.id !== event.id && prior.text.trim()) {
        transcript = [...transcript, { ...prior, seq }];
        seq += 1;
      }
      if (!event.final) {
        return {
          ...snap,
          transcript,
          seq,
          [slot]: { id: event.id, role: event.role, text: event.text, interrupted: event.interrupted },
        };
      }
      const line: VoiceLine = { id: event.id, role: event.role, text: event.text, interrupted: event.interrupted, seq };
      return { ...snap, transcript: [...transcript, line], seq: seq + 1, [slot]: undefined };
    }
    case "view-pending":
      return {
        ...snap,
        feed: [...snap.feed, { kind: "pending-view", id: event.id, name: event.name, seq: snap.seq }],
        seq: snap.seq + 1,
      };
    case "view": {
      // A view replaces its pending skeleton in place (same id) so the reveal
      // morphs instead of appending a duplicate entry.
      const at = snap.feed.findIndex((entry) => entry.id === event.id);
      if (at >= 0) {
        const prior = snap.feed[at]!;
        const next = [...snap.feed];
        next[at] = { kind: "view", id: event.id, node: event.node, seq: prior.seq };
        return { ...snap, feed: next };
      }
      return {
        ...snap,
        feed: [...snap.feed, { kind: "view", id: event.id, node: event.node, seq: snap.seq }],
        seq: snap.seq + 1,
      };
    }
    case "approval":
      return {
        ...snap,
        feed: [
          ...snap.feed,
          { kind: "approval", id: event.id, toolName: event.toolName, input: event.input, tier: event.tier, seq: snap.seq },
        ],
        seq: snap.seq + 1,
      };
    case "approval-resolved":
      return {
        ...snap,
        feed: snap.feed.map((entry) =>
          entry.kind === "approval" && entry.id === event.id ? { ...entry, resolution: event.resolution } : entry,
        ),
      };
    case "muted":
      return { ...snap, muted: event.muted, amplitude: event.muted ? 0 : snap.amplitude };
  }
}

/** Live controls the stage calls on the running session. */
export interface VoiceSessionActions {
  mute(muted: boolean): void;
  end(): void;
  approve(id: string, via: Exclude<ApprovalResolution, "declined">): void;
  decline(id: string): void;
}

export interface VoiceDriverHandle extends VoiceSessionActions {
  /** Hard teardown (unmount) — stop timers/streams without an "ended" beat. */
  stop(): void;
}

/**
 * The session seam. `start` is called once per session; the driver pushes
 * events through `emit` until it emits `{type:"status", status:"ended"}` or
 * `stop()` is called. The realtime WebRTC driver implements this same
 * interface at ENG-185 build-out; `createScriptedVoiceDriver` implements it
 * for demos and tests.
 */
export interface VoiceDriver {
  start(emit: (event: VoiceEvent) => void): VoiceDriverHandle;
}
