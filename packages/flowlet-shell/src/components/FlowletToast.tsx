import { useEffect } from "react";

export interface FlowletToastProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  durationMs?: number;
}

/** Quiet bottom toast with a single action — the shell's undo affordance
 *  (deletes are undoable rather than confirm-gated, per the ENG-183 gate). */
export function FlowletToast({
  message, actionLabel = "Undo", onAction, onDismiss, durationMs = 6000,
}: FlowletToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [durationMs, onDismiss]);

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
