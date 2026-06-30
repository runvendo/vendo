import { useRef, useState, type KeyboardEvent } from "react";
import { VoiceButton } from "./VoiceButton";
import { useVoiceInput } from "../use-voice-input";

export interface ComposerProps {
  onSend: (text: string) => void;
  status?: string;
  onStop?: () => void;
  placeholder?: string;
}

export function Composer({ onSend, status, onStop, placeholder = "Ask anything" }: ComposerProps) {
  const [value, setValue] = useState("");
  const voice = useVoiceInput();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const streaming = status === "streaming" || status === "submitted";
  const canSend = value.trim().length > 0;

  // Auto-grow the textarea up to the CSS max-height, then it scrolls internally.
  const resize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  };

  const submit = () => {
    if (streaming) return; // Enter during a run must not dispatch an overlapping turn.
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
    const ta = taRef.current;
    if (ta) ta.style.height = "auto";
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form className="fl-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea
        ref={taRef}
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={(e) => { setValue(e.target.value); resize(); }}
        onKeyDown={onKeyDown}
        aria-label="Message"
        enterKeyHint="send"
        autoComplete="off"
      />
      {voice.supported && <VoiceButton state={voice.state} onClick={voice.toggle} />}
      {streaming && onStop ? (
        <button type="button" className="fl-icon-btn" aria-label="Stop" onClick={onStop}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2.5" />
          </svg>
        </button>
      ) : (
        <button type="submit" className="fl-icon-btn fl-send" aria-label="Send" disabled={!canSend}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
          </svg>
        </button>
      )}
    </form>
  );
}
