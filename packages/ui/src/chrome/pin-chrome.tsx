import { log } from "@vendoai/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useVendoProvider } from "../context.js";
import { developmentMode } from "./dev-mode.js";
import { openVendoConversation } from "./overlay-registry.js";
import { GRACE_MS, useMenuDismiss } from "./remixable.js";
import { vendoToast } from "./vendo-toasts.js";

/**
 * S3 — what a person can DO with the app someone pinned into a host slot.
 *
 * A pinned app had no handle at all: it was a view that appeared, and changing
 * or removing it meant knowing to go ask the assistant. This is the handle, in
 * the grammar the page already speaks — the same 9px ✦ seed, the same bloom
 * into a pill, the same small popover as `<Remixable>` (remixable.tsx), because
 * a second vocabulary for the same gesture is a vocabulary nobody learns.
 *
 * REVEALED IS STATE, NOT `:hover`, for the reason Remixable documents: a
 * CSS-only reveal dies on the way to the pill, so the pill could never be
 * clicked. Touch has no hover at all, so a tap on the app reveals the seed and
 * a tap anywhere else puts it away.
 *
 * The bloom's timing and the dismissal are Remixable's own — imported, not
 * restated, so the two ✦ marks can never drift apart. `useMenuDismiss` is
 * scoped TWICE here, which is the whole of the touch behavior: the popover
 * closes on a press outside the popover, and the mark only goes away on a press
 * outside the APP, so tapping the app cannot undo the tap that revealed it.
 */

export function PinChrome({ appId, slotId, title, onRefresh, onUnpinned, children }: {
  appId: string;
  slotId: string;
  /** What the app calls itself — the prefill names the THING, never an id. */
  title: string;
  onRefresh(): void;
  onUnpinned(): void;
  children: ReactNode;
}) {
  const { client } = useVendoProvider();
  const [revealed, setRevealed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrap = useMenuDismiss(open, setOpen);
  const root = useMenuDismiss(revealed, setRevealed);
  const grace = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(grace.current), []);

  const reveal = () => {
    window.clearTimeout(grace.current);
    setRevealed(true);
  };
  // Focus outranks the cursor: a pointer leaving while the pill (or an item in
  // its popover) still holds focus must not take the mark away from underneath
  // a keyboard. Checked when the grace runs out, not when it is armed, because
  // blur fires BEFORE focus lands on wherever it went.
  const release = () => {
    window.clearTimeout(grace.current);
    grace.current = window.setTimeout(() => {
      if (root.current?.contains(document.activeElement) !== true) setRevealed(false);
    }, GRACE_MS);
  };

  const edit = () => {
    setOpen(false);
    setRevealed(false);
    // Same hand-off as the ✦ remix popover's "Open in panel": the person reads
    // the app's name, the agent reads the grounding, and nothing is sent.
    const opened = openVendoConversation({
      appId,
      prompt: `Update ${title}: `,
      context: `The view being edited is the "${title}" app (${appId}), pinned in the "${slotId}" slot.`,
      send: false,
    });
    if (!opened && developmentMode()) {
      log({
        code: "ui.pin-chrome-no-overlay",
        level: "warn",
        message: `[vendo] VendoSlot "${slotId}": "Edit in chat" opens the conversation surface — mount a VendoOverlay for it to land in.`,
      });
    }
  };

  const unpin = () => {
    setBusy(true);
    void client.apps.unplace(appId, slotId).then(
      () => {
        setOpen(false);
        setRevealed(false);
        onUnpinned();
      },
      (reason: unknown) => {
        // The row is still there, so nothing here may settle as though it were
        // gone: closing the popover over an app that stayed put is the same lie
        // the pin ring used to tell from a timer. One honest line — the exact
        // sentence a refused `apps.place` shows (pin-ceremony.ts) — and the
        // popover stays open, so Unpin is still under the cursor to try again.
        if (developmentMode()) {
          log({
            code: "ui.pin-chrome-unplace-failed",
            level: "warn",
            message: `[vendo] VendoSlot "${slotId}": unpinning ${appId} failed — ${String(reason)}`,
          });
        }
        vendoToast({ text: "That didn’t go through — try again.", state: "error" });
      },
    ).finally(() => setBusy(false));
  };

  return (
    <div
      className="fl-slot-filled"
      ref={root}
      {...(revealed || open ? { "data-vendo-revealed": "" } : {})}
      onPointerEnter={reveal}
      // Only a CURSOR leaves. A touch pointer's leave fires the instant the
      // finger lifts, which would take the mark away with the tap that asked
      // for it; the outside-press above is touch's dismissal.
      onPointerLeave={event => { if (event.pointerType === "mouse") release(); }}
      onFocus={reveal}
      onBlur={release}
    >
      {children}
      <span className="fl-remix-seed" aria-hidden="true">✦</span>
      <div className="fl-remix-menu-wrap" ref={wrap}>
        <button
          type="button"
          className="fl-remix-pill"
          aria-label={`Edit ${title}`}
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span aria-hidden="true" className="fl-remix-pill-mark">✦</span>
          Edit
        </button>
        {open ? (
          <div className="fl-remix-menu" role="group" aria-label={title}>
            <button type="button" onClick={edit}>Edit in chat</button>
            <button type="button" onClick={() => { setOpen(false); onRefresh(); }}>Refresh</button>
            <button type="button" className="is-danger" disabled={busy} onClick={unpin}>
              {busy ? "Unpinning…" : "Unpin"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
