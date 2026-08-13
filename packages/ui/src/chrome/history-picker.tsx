/** F10 (ENG-388) — the previous-conversations picker: a card floating over
 *  the conversation, opened from the overlay header. Selection hands the
 *  thread id back to the overlay (which owns the resume state); Cancel and
 *  Escape return to the conversation untouched. Internal to the overlay —
 *  deliberately not on the chrome export surface. */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { useThreads } from "../hooks/use-threads.js";

export function HistoryPicker({ activeThreadId, onResume, onCancel }: {
  /** The conversation currently on screen — never offered as "previous". */
  activeThreadId?: string | undefined;
  onResume: (threadId: string) => void;
  onCancel: () => void;
}) {
  // Mounted only while open, so the list is fetched fresh on every open.
  const { threads, error, isLoading } = useThreads();
  const card = useRef<HTMLDivElement>(null);
  // Focus lands on the card so the keyboard reaches the rows immediately;
  // the overlay hands focus back to the opener button on cancel.
  useEffect(() => {
    card.current?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    // Cancel the picker only — the overlay's own Escape (collapse, close)
    // must not also fire.
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };
  const rows = threads.filter(thread => thread.id !== activeThreadId);
  return (
    <div
      ref={card}
      className="fl-history"
      role="group"
      aria-label="Previous conversations"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="fl-history-head">
        <strong>Previous conversations</strong>
        <button type="button" className="fl-history-cancel" aria-label="Cancel" onClick={onCancel}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
          <span className="fl-sr-only">Cancel</span>
        </button>
      </div>
      {error !== undefined ? (
        <p className="fl-history-empty" role="status">Previous conversations could not load.</p>
      ) : rows.length === 0 ? (
        <p className="fl-history-empty" role="status">
          {isLoading ? "Loading…" : "No previous conversations yet."}
        </p>
      ) : (
        <ul className="fl-history-list">
          {rows.map(thread => (
            <li key={thread.id}>
              <button type="button" className="fl-history-row" onClick={() => onResume(thread.id)}>
                <span className="fl-history-title">{thread.title}</span>
                <time className="fl-history-time" dateTime={thread.updatedAt}>
                  {new Date(thread.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
