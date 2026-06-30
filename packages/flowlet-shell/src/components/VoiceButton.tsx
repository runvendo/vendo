import type { VoiceState } from "../use-voice-input";

export interface VoiceButtonProps {
  state?: VoiceState;
  onClick?: () => void;
}

export function VoiceButton({ state = "disabled", onClick }: VoiceButtonProps) {
  return (
    <button
      type="button"
      className="fl-icon-btn"
      aria-label="Voice input"
      disabled={state === "disabled"}
      aria-pressed={state === "recording"}
      onClick={onClick}
    >
      🎤
    </button>
  );
}
