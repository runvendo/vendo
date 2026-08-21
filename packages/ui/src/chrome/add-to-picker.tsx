/**
 * Placement — where a finished generated app goes, and the one affordance that
 * puts it there.
 *
 * THE REGISTRY IS THE CONFIG. A slot id is host markup, not a Vendo document,
 * so a mounted `VendoSlot` is the only thing that can say a slot exists; the
 * destinations come from what those slots have reported and from nowhere else.
 * That is the whole wiring — a host that mounts a slot gets placement without
 * naming it anywhere (there used to be a `pinSlot` prop on the provider; the
 * registry already knew, so it was a second copy of the same fact).
 *
 * `PlacementAction` is what every surface holding a finished app renders — the
 * in-thread card, the BYO embed card, the workspace stage — and it reads the
 * registry to decide which affordance that is:
 *
 *   none known — nothing at all, unless the host wired `onPin`; then the button
 *                is that hook and only that hook (the DIY path).
 *   one known  — a one-click **Pin to dashboard**: the real `apps.place` write
 *                with the pin ceremony behind it (pin-ceremony.ts). Naming the
 *                only place it could go would be a menu of one.
 *   several    — **Add to…**, the picker below: the person chooses, and the
 *                write is AWAITED, so "Added to Hero" is a fact, not a hope.
 *
 * One `.fl-barpin` affordance throughout — no second button language on an
 * app-card bar.
 */
import { useState } from "react";
import { useVendoProvider } from "../context.js";
import { useSlots } from "../hooks/use-slots.js";
import { announcePin } from "../pin-events.js";
import { usePinAction } from "./pin-ceremony.js";
import type { SlotEntry } from "../wire-types.js";

/** The pin mark, on the verb button and the picker alike. */
function PinMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 17v5M9 3h6l-1 7 3 3H7l3-3-1-7Z" />
    </svg>
  );
}

export function PlacementAction({ appId, payload, nudge, className, onPlaced }: {
  appId: string;
  /** Carried to the host's `onPin` mirror; the placement write needs only the id. */
  payload?: unknown;
  /** The affordance's invite state (`usePinNudge`) — the caller's, because only
   *  it knows whether the build on this surface just landed. */
  nudge?: string;
  /** An extra class for the bar this sits in (the stage pulls its own). */
  className?: string;
  /** Run once the app has a home. The stage closes the whole overlay on it, so
   *  the person lands back in the product looking at what they placed. */
  onPlaced?(): void;
}) {
  const { slots } = useSlots();
  const pin = usePinAction(slots.length === 1 ? slots[0]!.id : undefined);
  if (slots.length > 1) return <AddToPicker appId={appId} onPlaced={onPlaced} />;
  // Nowhere to put it and no host hook to hand it to: a pin would be a button
  // that does nothing, so there is no button.
  if (pin === undefined) return null;
  return (
    <button
      type="button"
      className={className === undefined ? "fl-barpin" : `fl-barpin ${className}`}
      {...(nudge === undefined ? {} : { "data-vendo-pin": nudge })}
      onClick={() => {
        pin({ appId, payload });
        onPlaced?.();
      }}
    >
      <PinMark />
      Pin to dashboard
    </button>
  );
}

export function AddToPicker({ appId, onPlaced }: { appId: string; onPlaced?(): void }) {
  const { client } = useVendoProvider();
  // A slot may mount (and report) after this picker first read, so opening the
  // menu re-reads: the destinations offered are the ones that exist NOW.
  const { slots, refresh } = useSlots();
  const [open, setOpen] = useState(false);
  const [placedIn, setPlacedIn] = useState<string>();
  const [failed, setFailed] = useState(false);

  const toggle = () => {
    void refresh();
    setFailed(false);
    setOpen(current => !current);
  };

  const choose = async (slot: SlotEntry) => {
    try {
      await client.apps.place(appId, slot.id);
      // Every mounted slot re-reads on the announcement instead of waiting out
      // its poll floor (pin-events.ts).
      announcePin(appId);
      setPlacedIn(slot.label);
      setOpen(false);
      onPlaced?.();
    } catch {
      // The wire's sentence is a developer's and this is a host's own page. One
      // honest line, and the menu stays open so they can try again.
      setFailed(true);
    }
  };

  if (slots.length === 0) return null;
  return (
    <span className="fl-slotpick">
      <button
        type="button"
        className="fl-barpin"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <PinMark />
        {placedIn === undefined ? "Add to…" : `Added to ${placedIn}`}
      </button>
      {open ? (
        <div
          className="fl-slotpick-menu"
          role="menu"
          onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}
        >
          {slots.map(slot => (
            <button key={slot.id} type="button" role="menuitem" onClick={() => void choose(slot)}>
              {slot.label}
            </button>
          ))}
          {failed ? <span className="fl-slotpick-note" role="alert">That didn’t go through — try again.</span> : null}
        </div>
      ) : null}
    </span>
  );
}
