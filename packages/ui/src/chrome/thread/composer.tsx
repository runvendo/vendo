import { useContext, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ConnectDockButton, ConnectTray } from "../connect-dock.js";
import { PrefillScopeContext, registerPrefillConsumer } from "../overlay-registry.js";
import { fileExt, fileToPart, formatBytes } from "./attachments.js";

/** The message shape the composer commits — mirrors useVendoThread.sendMessage. */
type OutgoingMessage = { text: string; files?: Awaited<ReturnType<typeof fileToPart>>[] };

/** Lane pick 2F — one attachment's eager-read lifecycle (drives the chip ring). */
type AttachmentRead = {
  status: "reading" | "ready" | "error";
  /** 0..1 read progress; meaningful while `reading`. */
  progress: number;
  part?: Awaited<ReturnType<typeof fileToPart>>;
};

/** ENG-225 — drag-drop attach: only reacts to drags that actually carry files
    (text selections dragged across the composer must not flash the drop zone).
    Exported for the thread-level drop surface (lane pick 2E). */
export const dragHasFiles = (event: React.DragEvent) =>
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
  // Lane pick 2F — attachments read EAGERLY at attach time. Each file's read
  // progress (FileReader onprogress) drives the chip ring; a failed read marks
  // that chip (inline retry) instead of surfacing only as a text line at send.
  // The finished part is cached so send doesn't re-read. Keyed by File identity,
  // mirroring the previews map; entries leave with their file.
  const [attachmentReads, setAttachmentReads] = useState<Map<File, AttachmentRead>>(new Map());
  const readsRef = useRef(attachmentReads);
  readsRef.current = attachmentReads;
  const startRead = (file: File) => {
    setAttachmentReads(prev => {
      const next = new Map(prev);
      next.set(file, { status: "reading", progress: 0 });
      return next;
    });
    fileToPart(file, fraction => {
      setAttachmentReads(prev => {
        const current = prev.get(file);
        if (!current || current.status !== "reading") return prev;
        const next = new Map(prev);
        next.set(file, { ...current, progress: fraction });
        return next;
      });
    }).then(
      part => setAttachmentReads(prev => {
        if (!prev.has(file)) return prev;
        const next = new Map(prev);
        next.set(file, { status: "ready", progress: 1, part });
        return next;
      }),
      () => setAttachmentReads(prev => {
        if (!prev.has(file)) return prev;
        const next = new Map(prev);
        next.set(file, { status: "error", progress: 0 });
        return next;
      }),
    );
  };
  useEffect(() => {
    setAttachmentReads(prev => {
      const next = new Map<File, AttachmentRead>();
      for (const file of files) {
        const existing = prev.get(file);
        if (existing) next.set(file, existing);
      }
      return next.size === prev.size && files.every(f => prev.has(f)) ? prev : next;
    });
    for (const file of files) {
      if (!readsRef.current.has(file)) startRead(file);
    }
    // startRead closes over stable setters only; files is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);
  // ENG-225 — the connect dock's liquid tray, anchored over the composer.
  const [dockOpen, setDockOpen] = useState(false);
  const dockButtonRef = useRef<HTMLButtonElement>(null);
  // ENG-215 — a message the user sent DURING a turn: it parks here (visible as a
  // pill) and auto-sends the instant the turn finishes. A single slot — a second
  // send while one is parked replaces it — because there is only ever one "next"
  // turn. Stop stays the explicit interrupt; queueing never cancels the stream.
  const [queued, setQueued] = useState<{ text: string; files: File[] } | null>(null);
  const [attachError, setAttachError] = useState<string>();

  // ENG-215 — commit a turn to the transport (attachment parts come from the
  // eager-read cache when ready, else a fresh read). Used both by an immediate
  // send and by the deferred flush of a queued message.
  const dispatch = (text: string, pending: File[]) => {
    void (async () => {
      let parts: Awaited<ReturnType<typeof fileToPart>>[];
      try {
        parts = await Promise.all(pending.map(file => {
          const cached = readsRef.current.get(file);
          return cached?.status === "ready" && cached.part ? Promise.resolve(cached.part) : fileToPart(file);
        }));
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

  // The enclosing overlay's prefill scope (null for embedded threads/pages):
  // registry-delivered prompts are directed at one overlay's composer.
  const prefillScope = useContext(PrefillScopeContext);
  // The listeners below register once but must send with CURRENT composer
  // state: a first-render `send` closure sees busy=false forever, so a remix
  // fired mid-stream would dispatch concurrently instead of parking in the
  // queued slot (the single-in-flight contract).
  const sendRef = useRef(send);
  sendRef.current = send;
  // Remix bridge: a host affordance (slot remix, a trigger button, the legacy
  // `vendo:prefill` event) opens this surface and hands it the request to
  // type + send, so the whole build happens here — the one conversational
  // place (08-ui §4). The registry consumer also drains a prompt parked while
  // this composer was still mounting (overlay first open / fresh conversation).
  useEffect(() => {
    const prefill = (prompt: string, sendNow: boolean) => {
      setDraft(prompt);
      if (sendNow) queueMicrotask(() => sendRef.current(prompt));
    };
    const onPrefill = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string; send?: boolean }>).detail;
      if (typeof detail?.prompt !== "string") return;
      prefill(detail.prompt, detail.send === true);
    };
    window.addEventListener("vendo:prefill", onPrefill);
    const unregister = registerPrefillConsumer(parked => prefill(parked.prompt, parked.send), prefillScope);
    return () => {
      window.removeEventListener("vendo:prefill", onPrefill);
      unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sendRef tracks the latest send; scope is mount-stable
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
    attachmentPreviews, attachmentReads, retryRead: startRead,
    dockOpen, setDockOpen, dockButtonRef,
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
    draft, setDraft, files, setFiles,
    attachmentPreviews, attachmentReads, retryRead,
    dockOpen, setDockOpen, dockButtonRef,
    queued, setQueued, attachError, fileRef, textareaRef, send,
  } = composer;
  // The tray exits with an animation instead of popping out of the DOM: on the
  // open→closed edge it stays mounted in a `closing` phase and unmounts on a
  // timer (not animationend — reduced-motion kills the animation and would
  // strand it). Reopening mid-exit cancels the timer and the tray never
  // remounts, so search text and scroll position survive the bounce.
  const [trayClosing, setTrayClosing] = useState(false);
  const trayWasOpenRef = useRef(dockOpen);
  useEffect(() => {
    const wasOpen = trayWasOpenRef.current;
    trayWasOpenRef.current = dockOpen;
    if (!wasOpen || dockOpen) return;
    setTrayClosing(true);
    const timer = setTimeout(() => setTrayClosing(false), 200);
    return () => {
      clearTimeout(timer);
      setTrayClosing(false);
    };
  }, [dockOpen]);
  return (
    <div className="fl-dock-anchor">
      {dockOpen || trayClosing ? (
        <ConnectTray
          closing={!dockOpen}
          anchorRef={dockButtonRef}
          onClose={() => {
            setDockOpen(false);
            queueMicrotask(() => dockButtonRef.current?.focus());
          }}
        />
      ) : null}
    {/* Lane pick 2E — drag-drop moved UP to the whole thread surface (see
        VendoThread): the bar itself no longer owns enter/leave/drop. */}
    <form
      className="fl-composer"
      aria-label="Message composer"
      onSubmit={event => { event.preventDefault(); send(); }}
    >
      {attachError ? <div className="fl-att-error" role="alert">{attachError}</div> : null}
      {queued ? (
        <div className="fl-queued" role="status" aria-live="polite">
          <span className="fl-queued-tag">Queued</span>
          <span className="fl-queued-text">{queued.text || `${queued.files.length} attachment(s)`}</span>
          <span className="fl-queued-hint">sends when the reply finishes</span>
          {/* Lane pick 2B — Send now: stop the stream; the ENG-215 busy-edge
              flush then dispatches this queued slot immediately. One code
              path for both the polite wait and the deliberate interrupt. */}
          <button type="button" className="fl-queued-now" onClick={onStop}>Send now</button>
          <button type="button" className="fl-att-rm fl-queued-rm" aria-label="Cancel queued message" onClick={() => setQueued(null)}>×</button>
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="fl-att-chips">
          {files.map((file, i) => {
            const preview = attachmentPreviews.get(file);
            const read = attachmentReads.get(file);
            // An errored image renders as the file-style error chip, so its
            // remove button needs the file-chip placement too.
            const asFileChip = preview === undefined || read?.status === "error";
            const remove = (
              <button type="button" className={`fl-att-rm${asFileChip ? " fl-att-rm-file" : ""}`} aria-label={`Remove ${file.name}`}
                onClick={() => setFiles(current => current.filter((_, j) => j !== i))}>×</button>
            );
            // ENG-225 — images preview as the designed thumbnail chip; other
            // files carry an extension badge plus name and size. An image whose
            // READ failed falls through to the error file-chip below (retry in
            // place) instead of silently posing as attachable — the object-URL
            // thumbnail says nothing about whether FileReader could read it
            // (AI-review catch).
            if (preview !== undefined && read?.status !== "error") {
              return (
                <span className="fl-att-img" key={`${file.name}-${i}`}>
                  <img src={preview} alt={file.name} />
                  {remove}
                </span>
              );
            }
            // Lane pick 2F — the chip narrates its read: progress ring while
            // reading, error + inline retry on failure, quiet size when ready.
            const failed = read?.status === "error";
            const reading = read?.status === "reading";
            const ring = 2 * Math.PI * 7;
            return (
              <span className={`fl-att-file${failed ? " fl-att-file--error" : ""}`} key={`${file.name}-${i}`}>
                {reading ? (
                  <span className="fl-att-ring" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 18 18">
                      <circle className="fl-att-ring-bg" cx="9" cy="9" r="7" />
                      <circle className="fl-att-ring-fg" cx="9" cy="9" r="7"
                        strokeDasharray={ring} strokeDashoffset={ring * (1 - (read?.progress ?? 0))} />
                    </svg>
                  </span>
                ) : (
                  <span className="fl-att-ext" aria-hidden="true">{fileExt(file.name)}</span>
                )}
                <span className="fl-att-meta">
                  <span className="fl-att-name">{file.name}</span>
                  {failed ? (
                    <small className="fl-att-fail" role="alert">
                      couldn&rsquo;t read — <button type="button" className="fl-att-retry" onClick={() => retryRead(file)}>retry</button>
                    </small>
                  ) : (
                    <small>{reading ? "reading…" : formatBytes(file.size)}</small>
                  )}
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
      {/* Lane pick 2C — focus bloom: a one-line hint row that exists only
          while the composer holds focus (pure CSS via :focus-within). Teaches
          the hidden powers exactly when attention is on the bar. */}
      <div className="fl-hintrow" aria-hidden="true">
        <span><kbd className="fl-kbd">⇧↵</kbd> new line</span>
        <span><kbd className="fl-kbd">⌘K</kbd> commands</span>
        <span>drop files anywhere</span>
      </div>
      <span role="status" aria-live="polite" className="fl-sr-only">
        {errorMessage !== undefined ? `error: ${errorMessage}` : status}
      </span>
    </form>
    </div>
  );
}
