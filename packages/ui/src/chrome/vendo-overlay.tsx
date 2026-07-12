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
      <button ref={launcher} className="vendo-launcher" type="button" aria-expanded={open} aria-controls="vendo-overlay-dialog" onClick={() => setOpen(value => !value)}>
        Vendo
      </button>
      {open ? (
        <div className="vendo-overlay">
          <div ref={dialog} id="vendo-overlay-dialog" className="vendo-dialog" role="dialog" aria-modal="true" aria-label="Vendo assistant" onKeyDown={onKeyDown}>
            <div className="vendo-row"><strong>Vendo</strong><button type="button" aria-label="Close Vendo" onClick={close}>Close</button></div>
            <VendoThread />
          </div>
        </div>
      ) : null}
    </ChromeRoot>
  );
}
