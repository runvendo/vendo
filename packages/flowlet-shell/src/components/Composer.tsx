import { useState, type KeyboardEvent } from "react";
import { VoiceButton } from "./VoiceButton";
import { useVoiceInput } from "../use-voice-input";

export interface ComposerProps {
  onSend: (text: string) => void;
  status?: string;
  onStop?: () => void;
  placeholder?: string;
}

export function Composer({ onSend, status, onStop, placeholder = "ask anything" }: ComposerProps) {
  const [value, setValue] = useState("");
  const voice = useVoiceInput();
  const streaming = status === "streaming" || status === "submitted";

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form className="fl-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Message"
      />
      <VoiceButton state={voice.state} onClick={voice.toggle} />
      {streaming && onStop ? (
        <button type="button" className="fl-icon-btn" aria-label="Stop" onClick={onStop}>■</button>
      ) : (
        <button type="submit" className="fl-icon-btn fl-send" aria-label="Send">↑</button>
      )}
    </form>
  );
}
