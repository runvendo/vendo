import { useEffect, useRef, type RefObject } from "react";
import type { VoiceTranscriptEntry } from "./driver.js";

export interface VoiceDrawerProps {
  open: boolean;
  transcript: VoiceTranscriptEntry[];
  toggleRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
}

export function VoiceDrawer({ open, transcript, toggleRef, onClose }: VoiceDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) drawerRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const close = () => {
    onClose();
    queueMicrotask(() => toggleRef.current?.focus());
  };

  return (
    <div
      ref={drawerRef}
      id="vendo-voice-transcript"
      className="fl-voice-drawer"
      role="dialog"
      aria-label="Session transcript"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        close();
      }}
    >
      {transcript.length === 0 ? (
        <div className="fl-voice-drawer-empty">No transcript yet</div>
      ) : transcript.map((entry) => (
        <div key={entry.id} className={`fl-voice-line is-${entry.role === "user" ? "user" : "agent"}`}>
          <span className="fl-voice-line-role">{entry.role === "user" ? "You" : "Assistant"}</span>
          <span>{entry.text}</span>
        </div>
      ))}
    </div>
  );
}
