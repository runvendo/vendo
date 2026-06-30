export type VoiceState = "idle" | "recording" | "disabled";

export interface VoiceInput {
  supported: boolean;
  state: VoiceState;
  toggle: () => void;
}

/** Stub seam. A real capture pipeline replaces this later. */
export function useVoiceInput(): VoiceInput {
  return { supported: false, state: "disabled", toggle: () => {} };
}
