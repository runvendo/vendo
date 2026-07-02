import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import type { FileUIPart } from "ai";
import { VoiceButton } from "./VoiceButton";
import { AttachmentChips } from "./AttachmentChips";
import { useVoiceInput } from "../use-voice-input";
import { ACCEPT_ATTR, useAttachments } from "../use-attachments";

export interface ComposerProps {
  onSend: (text: string, files?: FileUIPart[]) => void;
  status?: string;
  onStop?: () => void;
  placeholder?: string;
}

export function Composer({ onSend, status, onStop, placeholder = "Ask anything" }: ComposerProps) {
  const [value, setValue] = useState("");
  const [dragging, setDragging] = useState(false);
  const voice = useVoiceInput();
  const att = useAttachments();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streaming = status === "streaming" || status === "submitted";
  const canSend = value.trim().length > 0 || att.attachments.length > 0;

  // Auto-grow the textarea up to the CSS max-height, then it scrolls internally.
  const resize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  };

  const submit = async () => {
    if (streaming) return; // Enter during a run must not dispatch an overlapping turn.
    const text = value.trim();
    if (!text && att.attachments.length === 0) return;
    const files = att.attachments.length > 0 ? await att.toParts() : undefined;
    onSend(text, files);
    setValue("");
    att.clear();
    const ta = taRef.current;
    if (ta) ta.style.height = "auto";
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      att.add(files);
    }
  };

  const onDrop = (e: DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) att.add(e.dataTransfer.files);
  };

  const onDragOver = (e: DragEvent<HTMLFormElement>) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      setDragging(true);
    }
  };

  return (
    <form
      className={`fl-composer ${dragging ? "fl-composer-drag" : ""}`}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      onDragOver={onDragOver}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
    >
      {dragging && <div className="fl-drop" aria-hidden="true">Drop images or PDFs to attach</div>}
      <AttachmentChips attachments={att.attachments} onRemove={att.remove} />
      {att.error && <div className="fl-att-error" role="alert">{att.error}</div>}
      <div className="fl-composer-row">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          hidden
          onChange={(e) => { if (e.target.files) att.add(e.target.files); e.target.value = ""; }}
        />
        <button type="button" className="fl-icon-btn fl-attach" aria-label="Attach files" onClick={() => fileRef.current?.click()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          placeholder={placeholder}
          onChange={(e) => { setValue(e.target.value); resize(); }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
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
      </div>
    </form>
  );
}
