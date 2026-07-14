/** The public transport seam for the voice stage (08-ui §1, §3). */

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

export type KnownVoiceDriverEvent =
  | { type: "state"; state: VoiceSessionState }
  | { type: "transcript"; entry: VoiceTranscriptEntry }
  | { type: "amplitude"; level: number }
  | { type: "error"; error: VoiceDriverError };

/**
 * Unknown event variants are deliberately accepted and ignored by consumers,
 * matching core's forward-compatible stream rule (01-core §15).
 */
export type VoiceDriverEvent = KnownVoiceDriverEvent | { type: string; [key: string]: unknown };

export interface VoiceDriverHandlers {
  onEvent(event: VoiceDriverEvent): void;
}

export interface VoiceSessionHandle {
  setMuted?(muted: boolean): void;
  stop(): void;
}

export interface VoiceDriver {
  start(handlers: VoiceDriverHandlers): VoiceSessionHandle;
}
