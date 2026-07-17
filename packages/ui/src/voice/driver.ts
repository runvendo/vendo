/** The public transport seam for the voice stage (08-ui §1, §3). */
import type { UIPayload } from "@vendoai/core";

export type VoiceState =
  | "unavailable"
  | "idle"
  | "connecting"
  | "reconnecting"
  | "listening"
  | "speaking"
  | "error";

export type VoiceSessionState = Extract<VoiceState, "connecting" | "reconnecting" | "listening" | "speaking">;

export interface VoiceTranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
}

export interface VoiceDriverError {
  message: string;
  cause?: unknown;
}

export interface VoiceSessionView {
  id: string;
  appId: string;
  payload: UIPayload;
}

export type KnownVoiceDriverEvent =
  | { type: "state"; state: VoiceSessionState }
  | { type: "transcript"; entry: VoiceTranscriptEntry }
  | { type: "amplitude"; level: number }
  | { type: "view"; view: VoiceSessionView }
  | { type: "error"; error: VoiceDriverError };

/**
 * Unknown event variants are deliberately accepted and ignored by consumers,
 * matching core's forward-compatible stream rule (01-core §15).
 */
export type VoiceDriverEvent = KnownVoiceDriverEvent | { type: string; [key: string]: unknown };

export interface VoiceDriverHandlers {
  onEvent(event: VoiceDriverEvent): void;
}

/** ENG-319 — one realtime function call, as the driver hands it to the bridge. */
export interface VoiceToolCall {
  callId: string;
  name: string;
  args: unknown;
}

/** ENG-319 — what a tool-call handler can do back into the live session. */
export interface VoiceActSession {
  /** Land a rendered view in the stage's session feed. */
  emitView(view: VoiceSessionView): void;
}

/** ENG-319 — the realtime tool-call bridge seam: `tools` ride the provider
    session config; every model function call funnels through `onToolCall`,
    whose resolved value returns to the model as the function output. */
export interface VoiceToolBridge {
  tools: Array<Record<string, unknown>>;
  onToolCall(call: VoiceToolCall, session: VoiceActSession): Promise<unknown>;
}

export interface VoiceSessionHandle {
  setMuted?(muted: boolean): void;
  stop(): void;
}

export interface VoiceDriver {
  start(handlers: VoiceDriverHandlers): VoiceSessionHandle;
}
