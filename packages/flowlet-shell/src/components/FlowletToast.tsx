import { useEffect, useRef } from "react";

export interface FlowletToastProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  durationMs?: number;
}

/** Quiet bottom toast with a single action — the shell's undo affordance
 *  (deletes are undoable rather than confirm-gated, per the ENG-183 gate).
 *  Callers showing a SEQUENCE of toasts should key each by its subject so
 *  every one gets a fresh countdown. */
export function FlowletToast({
  message, actionLabel = "Undo", onAction, onDismiss, durationMs = 6000,
}: FlowletToastProps) {
  // The countdown is anchored to the component instance, not the callback
  // identity — an inline `onDismiss` re-created by parent renders must not
  // keep resetting (and silently extending) the window.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    const timer = setTimeout(() => onDismissRef.current(), durationMs);
    return () => clearTimeout(timer);
  }, [durationMs]);

  return (
    <div className="fl-toast" role="status">
      <span className="fl-toast-msg">{message}</span>
      {onAction && (
        <button type="button" className="fl-toast-action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
