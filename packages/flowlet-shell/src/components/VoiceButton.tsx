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
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
        <line x1="12" y1="19" x2="12" y2="22" />
      </svg>
    </button>
  );
}
