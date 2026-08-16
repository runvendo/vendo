/**
 * Toast — a transient notice in the corner, for something that already
 * happened. Base UI's toast manager owns the part that is easy to get wrong:
 * the auto-dismiss timer pauses while the notice is hovered or focused (WCAG
 * 2.2.1) and resumes with the remainder, and the stack announces politely.
 *
 * The brick's contract is declarative — `open` is the truth and the manager is
 * driven to match it — because a generated screen holds its state in `$state`
 * and has nowhere to keep an imperative handle.
 */
import { Toast as Base } from "@base-ui/react/toast";
import { useEffect, useRef } from "react";
import { OverlayPortal } from "../../tree/overlay-portal.js";
import { font, resolveTone, t, toneStyle } from "../tokens.js";
import { closeStyle } from "./dialog.js";

export interface ToastProps {
  open?: boolean;
  onClose?: () => void;
  message?: string;
  tone?: string;
  duration?: number;
}

/** One notice per brick, so re-raising the same one refreshes it in place
 *  rather than stacking a duplicate. */
const TOAST_ID = "vendo-kit-toast";

function Notice({ open = false, onClose, message, tone, duration }: ToastProps) {
  const { add, close, toasts } = Base.useToastManager();
  const raised = useRef(false);
  // Held in a ref, NOT in the effect's deps: `add` with a known id refreshes the
  // auto-dismiss timer, so an inline `onClose` in the deps would restart the
  // countdown on every render and the notice would never leave.
  const closing = useRef(onClose);
  closing.current = onClose;

  useEffect(() => {
    if (open) {
      // Unconditionally, NOT only on the way up: `add` with a known id updates
      // that toast in place and refreshes its timer, which is the whole way a
      // declarative notice re-states itself. Gating this on "not already
      // raised" pinned the FIRST message and the FIRST duration for as long as
      // `open` stayed true — a second, different notice silently showed the
      // first one's text. The deps are what keep the timer honest: `add` and
      // `close` are stable (read off the provider's store), so this runs when
      // the notice actually changes and not once per render.
      raised.current = true;
      add({ id: TOAST_ID, description: message, timeout: duration ?? 5000, onClose: () => closing.current?.() });
    } else if (raised.current) {
      raised.current = false;
      close(TOAST_ID);
    }
  }, [open, message, duration, add, close]);

  const paint = toneStyle[resolveTone(tone)];
  return (
    <OverlayPortal>
      {(host) => host === null ? null : (
        <Base.Portal container={host}>
          <Base.Viewport
            style={{
              position: "fixed",
              right: 16,
              bottom: 16,
              display: "flex",
              flexDirection: "column",
              gap: "var(--vendo-density-inline-gap, 7px)",
              width: "min(360px, calc(100vw - 32px))",
            }}
          >
            {toasts.map((toast) => (
              <Base.Root
                key={toast.id}
                toast={toast}
                data-kit="Toast"
                style={{
                  ...font,
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--vendo-density-inline-gap, 7px)",
                  boxSizing: "border-box",
                  border: `${t.borderWidth} solid ${paint.border}`,
                  borderRadius: t.radiusMedium,
                  color: paint.color,
                  background: paint.background,
                  boxShadow: t.shadowSmall,
                  padding: "var(--vendo-density-card-padding, 16px)",
                }}
              >
                <Base.Description style={{ margin: 0, flex: 1, minWidth: 0 }}>{toast.description}</Base.Description>
                <Base.Close data-kit-close="" aria-label="Close" style={{ ...closeStyle, color: "inherit" }}>
                  ✕
                </Base.Close>
              </Base.Root>
            ))}
          </Base.Viewport>
        </Base.Portal>
      )}
    </OverlayPortal>
  );
}

export function Toast(props: ToastProps) {
  return (
    <Base.Provider>
      <Notice {...props} />
    </Base.Provider>
  );
}
