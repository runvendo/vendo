import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ConnectDockButton, ConnectTray } from "../connect-dock.js";
import { fileExt, fileToPart, formatBytes } from "./attachments.js";

/** The message shape the composer commits — mirrors useVendoThread.sendMessage. */
type OutgoingMessage = { text: string; files?: Awaited<ReturnType<typeof fileToPart>>[] };

/** ENG-225 — drag-drop attach: only reacts to drags that actually carry files
    (text selections dragged across the composer must not flash the drop zone). */
const dragHasFiles = (event: React.DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");

/** All composer state and send/queue mechanics, lifted to the thread level so
    the draft (and queued slot) survive the landing ↔ transcript flip. The
    Composer component below is the matching presentation. */
export function useComposer({ busy, sendMessage }: {
  busy: boolean;
  sendMessage: (message: OutgoingMessage) => unknown;
}) {
  const [draft, setDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  // ENG-225 — drag-drop attach. A depth counter, not a boolean: dragging over
  // the composer's children fires enter/leave pairs for every element crossed.
  const [dragDepth, setDragDepth] = useState(0);
  // ENG-225 — object-URL thumbnails for image attachments in the chip strip.
  // Keyed by File identity; a URL is minted once per file and revoked only when
  // that file leaves the set — never recreated for files still shown (which
  // would briefly point a mounted <img> at a revoked URL, Devin review). The
  // ref mirrors the state so the unmount cleanup revokes the final set.
  const [attachmentPreviews, setAttachmentPreviews] = useState<Map<File, string>>(new Map());
  const previewsRef = useRef(attachmentPreviews);
  previewsRef.current = attachmentPreviews;
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return;
    setAttachmentPreviews(prev => {
      const next = new Map<File, string>();
      for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        next.set(file, prev.get(file) ?? URL.createObjectURL(file));
      }
      // Revoke only URLs for files that are no longer attached.
      for (const [file, url] of prev) {
        if (!next.has(file)) URL.revokeObjectURL(url);
      }
      return next;
    });
  }, [files]);
  // Final cleanup on unmount: revoke whatever is still live.
  useEffect(() => () => {
    for (const url of previewsRef.current.values()) URL.revokeObjectURL(url);
  }, []);
  // ENG-225 — the connect dock's liquid tray, anchored over the composer.
  const [dockOpen, setDockOpen] = useState(false);
  const dockButtonRef = useRef<HTMLButtonElement>(null);
  // ENG-215 — a message the user sent DURING a turn: it parks here (visible as a
  // pill) and auto-sends the instant the turn finishes. A single slot — a second
  // send while one is parked replaces it — because there is only ever one "next"
  // turn. Stop stays the explicit interrupt; queueing never cancels the stream.
  const [queued, setQueued] = useState<{ text: string; files: File[] } | null>(null);
  const [attachError, setAttachError] = useState<string>();

  // ENG-215 — commit a turn to the transport (reads any attachments first). Used
  // both by an immediate send and by the deferred flush of a queued message.
  const dispatch = (text: string, pending: File[]) => {
    void (async () => {
      let parts: Awaited<ReturnType<typeof fileToPart>>[];
      try {
        parts = await Promise.all(pending.map(fileToPart));
      } catch (reason) {
        // A file read failed — surface it and restore the message so it never
        // vanishes silently.
        setAttachError(reason instanceof Error ? reason.message : "Couldn't read an attachment.");
        setDraft(current => current || text);
        setFiles(current => (current.length > 0 ? current : pending));
        return;
      }
      setAttachError(undefined);
      void sendMessage(parts.length > 0 ? { text, files: parts } : { text });
    })();
  };

  const send = (override?: string) => {
    const text = (override ?? draft).trim();
    const pending = files;
    if (!text && pending.length === 0) return;
    // The message leaves the input immediately (whether it sends now or parks).
    setDraft("");
    setFiles([]);
    if (fileRef.current) fileRef.current.value = "";
    if (busy) {
      setQueued({ text, files: pending });
      return;
    }
    dispatch(text, pending);
  };

  // Remix bridge: a host affordance (the hero card's "Remix") opens this
  // surface and hands it the request to type + send, so the whole build
  // happens here — the one conversational place (08-ui §4).
  useEffect(() => {
    const onPrefill = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string; send?: boolean }>).detail;
      if (typeof detail?.prompt !== "string") return;
      setDraft(detail.prompt);
      if (detail.send) queueMicrotask(() => send(detail.prompt));
    };
    window.addEventListener("vendo:prefill", onPrefill);
    return () => window.removeEventListener("vendo:prefill", onPrefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send closes over stable refs
  }, []);

  // Flush the queued message the moment the active turn finishes. A ref-tracked
  // busy edge keeps this from firing on unrelated re-renders.
  const wasBusyRef = useRef(busy);
  useEffect(() => {
    if (wasBusyRef.current && !busy && queued) {
      const pending = queued;
      setQueued(null);
      dispatch(pending.text, pending.files);
    }
    wasBusyRef.current = busy;
    // dispatch is recreated each render but closes only over stable setters and
    // thread.sendMessage; the busy edge + queued slot are the real triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queued]);

  // ENG-215 — autogrow: the textarea tracks its content height (CSS caps it at
  // max-height and scrolls past that). Runs on every draft change, including the
  // programmatic reset on send and the refill on edit.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [draft]);

  return {
    draft, setDraft, files, setFiles, dragDepth, setDragDepth,
    attachmentPreviews, dockOpen, setDockOpen, dockButtonRef,
    queued, setQueued, attachError, fileRef, textareaRef, send,
  };
}

export type ComposerApi = ReturnType<typeof useComposer>;

export interface ComposerProps {
  composer: ComposerApi;
  busy: boolean;
  /** The live transport status + error for the sr-only announcement span. */
  status: string;
  errorMessage?: string;
  onStop: () => void;
  onVoice?: (() => void) | undefined;
}

/** The message composer (08-ui §4): attachments, drag-drop, queueing, dock. */
export function Composer({ composer, busy, status, errorMessage, onStop, onVoice }: ComposerProps) {
  const {
    draft, setDraft, files, setFiles, dragDepth, setDragDepth,
    attachmentPreviews, dockOpen, setDockOpen, dockButtonRef,
    queued, setQueued, attachError, fileRef, textareaRef, send,
  } = composer;
  return (
    <div className="fl-dock-anchor">
      {dockOpen ? (
        <ConnectTray
          anchorRef={dockButtonRef}
          onClose={() => {
            setDockOpen(false);
            queueMicrotask(() => dockButtonRef.current?.focus());
          }}
        />
      ) : null}
    <form
      className={`fl-composer${dragDepth > 0 ? " fl-composer-drag" : ""}`}
      aria-label="Message composer"
      onSubmit={event => { event.preventDefault(); send(); }}
      onDragEnter={event => {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        setDragDepth(depth => depth + 1);
      }}
      onDragOver={event => {
        if (dragHasFiles(event)) event.preventDefault();
      }}
      onDragLeave={event => {
        if (dragHasFiles(event)) setDragDepth(depth => Math.max(0, depth - 1));
      }}
      onDrop={event => {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        setDragDepth(0);
        const dropped = Array.from(event.dataTransfer.files);
        if (dropped.length > 0) setFiles(current => [...current, ...dropped]);
      }}
    >
      {dragDepth > 0 ? <div className="fl-drop">Drop files to attach</div> : null}
      {attachError ? <div className="fl-att-error" role="alert">{attachError}</div> : null}
      {queued ? (
        <div className="fl-queued" role="status" aria-live="polite">
          <span className="fl-queued-tag">Queued</span>
          <span className="fl-queued-text">{queued.text || `${queued.files.length} attachment(s)`}</span>
          <span className="fl-queued-hint">sends when the reply finishes</span>
          <button type="button" className="fl-att-rm fl-queued-rm" aria-label="Cancel queued message" onClick={() => setQueued(null)}>×</button>
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="fl-att-chips">
          {files.map((file, i) => {
            const preview = attachmentPreviews.get(file);
            const remove = (
              <button type="button" className={`fl-att-rm${preview === undefined ? " fl-att-rm-file" : ""}`} aria-label={`Remove ${file.name}`}
                onClick={() => setFiles(current => current.filter((_, j) => j !== i))}>×</button>
            );
            // ENG-225 — images preview as the designed thumbnail chip; other
            // files carry an extension badge plus name and size.
            if (preview !== undefined) {
              return (
                <span className="fl-att-img" key={`${file.name}-${i}`}>
                  <img src={preview} alt={file.name} />
                  {remove}
                </span>
              );
            }
            return (
              <span className="fl-att-file" key={`${file.name}-${i}`}>
                <span className="fl-att-ext" aria-hidden="true">{fileExt(file.name)}</span>
                <span className="fl-att-meta">
                  <span className="fl-att-name">{file.name}</span>
                  <small>{formatBytes(file.size)}</small>
                </span>
                {remove}
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="fl-composer-row">
        <input ref={fileRef} type="file" multiple hidden aria-hidden="true"
          onChange={event => { if (event.target.files) setFiles(current => [...current, ...Array.from(event.target.files!)]); }} />
        <ConnectDockButton ref={dockButtonRef} open={dockOpen} onToggle={() => setDockOpen(value => !value)} />
        <button type="button" className="fl-icon-btn fl-attach" aria-label="Attach files" onClick={() => fileRef.current?.click()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <label style={{ display: "contents" }}>
          <span className="fl-sr-only">Message</span>
          <textarea
            ref={textareaRef}
            aria-label="Message"
            placeholder="Ask anything"
            rows={1}
            value={draft}
            // ENG-215 — never disabled: typing (and queueing) stays live through
            // the whole turn, and the composer never dumps focus to <body>.
            onChange={event => setDraft(event.currentTarget.value)}
            onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
            }}
          />
        </label>
        {onVoice ? (
          <button type="button" className="fl-icon-btn" aria-label="Start voice" onClick={onVoice}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 19v3" />
            </svg>
          </button>
        ) : null}
        {/* ENG-215 — Stop is the explicit interrupt (only mid-turn); Send is
            always available and, during a turn, queues the message instead. */}
        {busy ? (
          <button className="fl-icon-btn fl-stop" type="button" aria-label="Stop" onClick={onStop}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
            <span className="fl-sr-only">Stop</span>
          </button>
        ) : null}
        <button className="fl-icon-btn fl-send" type="submit" aria-label="Send" disabled={!draft.trim() && files.length === 0}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
          </svg>
          <span className="fl-sr-only">Send</span>
        </button>
      </div>
      <span role="status" aria-live="polite" className="fl-sr-only">
        {errorMessage !== undefined ? `error: ${errorMessage}` : status}
      </span>
    </form>
    </div>
  );
}
