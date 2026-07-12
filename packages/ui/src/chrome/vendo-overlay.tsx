import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChromeRoot } from "./chrome-root.js";
import { VendoThread } from "./vendo-thread.js";

const FOCUSABLE = "button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])";

/** 08-ui §4 — floating modal launcher with focus containment and restoration. */
export function VendoOverlay() {
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) dialog.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    queueMicrotask(() => launcher.current?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <ChromeRoot>
      <button ref={launcher} className="fl-launcher" type="button" aria-expanded={open} aria-controls="vendo-overlay-dialog" onClick={() => setOpen(value => !value)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Z" />
          <path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z" />
        </svg>
        Vendo
      </button>
      {open ? (
        <div className="fl-overlay-portal">
          <div className="fl-overlay-scrim" />
          <div ref={dialog} id="vendo-overlay-dialog" className="fl-overlay-panel" role="dialog" aria-modal="true" aria-label="Vendo assistant" onKeyDown={onKeyDown}>
            <strong className="fl-sr-only">Vendo</strong>
            <button className="fl-overlay-close" type="button" aria-label="Close Vendo" onClick={close}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
              <span className="fl-sr-only">Close</span>
            </button>
            <VendoThread />
          </div>
        </div>
      ) : null}
    </ChromeRoot>
  );
}
