import { useState } from "react";

export type Feedback = "up" | "down";

export interface TurnActionsProps {
  /** The assistant turn's raw markdown — what Copy writes to the clipboard. */
  text: string;
  /** Regenerate this turn (SDK `regenerate`). Omit to hide the control. */
  onRegenerate?: () => void;
  /** True when this turn errored — swaps Regenerate for a labelled Retry. */
  errored?: boolean;
  /** Host feedback sink. Receives the vote; the shell stores no feedback itself. */
  onFeedback?: (feedback: Feedback) => void;
  /** Wall-clock time this turn arrived (ms). Shown on hover. */
  timestamp?: number;
}

function Icon({ path }: { path: React.ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {path}
    </svg>
  );
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

/**
 * The quiet control row under an assistant turn: copy, regenerate (or retry on
 * error), thumbs up/down, and a hover timestamp. Feedback is local UI state that
 * is forwarded to the host via `onFeedback`; the shell keeps no feedback store.
 */
export function TurnActions({ text, onRegenerate, errored, onFeedback, timestamp }: TurnActionsProps) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<Feedback | null>(null);

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  const sendFeedback = (next: Feedback) => {
    const value = vote === next ? null : next; // toggle off if re-pressed
    setVote(value);
    if (value) onFeedback?.(value);
  };

  return (
    <div className="fl-turn-actions" data-testid="turn-actions">
      <button type="button" className="fl-turn-btn" aria-label={copied ? "Copied" : "Copy"} onClick={copy}>
        {copied ? (
          <Icon path={<path d="M20 6 9 17l-5-5" />} />
        ) : (
          <Icon path={<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>} />
        )}
      </button>

      {onRegenerate && (
        errored ? (
          <button type="button" className="fl-turn-btn fl-turn-retry" onClick={onRegenerate}>
            <Icon path={<><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></>} />
            Retry
          </button>
        ) : (
          <button type="button" className="fl-turn-btn" aria-label="Regenerate" onClick={onRegenerate}>
            <Icon path={<><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></>} />
          </button>
        )
      )}

      {onFeedback && (
        <>
          <button
            type="button"
            className={`fl-turn-btn ${vote === "up" ? "fl-turn-up" : ""}`}
            aria-label="Good response"
            aria-pressed={vote === "up"}
            onClick={() => sendFeedback("up")}
          >
            <Icon path={<><path d="M7 10v11" /><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" /></>} />
          </button>
          <button
            type="button"
            className={`fl-turn-btn ${vote === "down" ? "fl-turn-down" : ""}`}
            aria-label="Bad response"
            aria-pressed={vote === "down"}
            onClick={() => sendFeedback("down")}
          >
            <Icon path={<><path d="M17 14V3" /><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" /></>} />
          </button>
        </>
      )}

      {typeof timestamp === "number" && <span className="fl-turn-ts">{formatTime(timestamp)}</span>}
    </div>
  );
}
