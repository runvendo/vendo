/**
 * "Add to…" — the placement write from a surface that is not the host's page.
 *
 * A BYO chat page renders a generated app inline; the app belongs on the
 * dashboard. The destinations come from slot-notes (a mounted `VendoSlot` is the
 * only thing that knows a slot exists — a slot id is host markup, not a Vendo
 * document), and the write is `apps.place`, AWAITED here: "Added to Hero" is a
 * fact, not a hope. With nothing noted there is nowhere to add to, and the
 * affordance renders nothing at all rather than an empty menu.
 *
 * The same `.fl-barpin` affordance the thread card's pin uses — no new button
 * language on the app-card bar. The thread card swaps ITS pin for this picker
 * once the origin knows more than one destination (thread/parts.tsx), which is
 * what makes the choice reachable from a conversation in a real host and not
 * only from a BYO page that mounts `VendoAppEmbed` itself.
 */
import { useCallback, useEffect, useState } from "react";
import { useVendoProvider } from "../context.js";
import { announcePin } from "../pin-events.js";
import { knownSlots, type SlotNote } from "../slot-notes.js";

/** The slots this origin has seen, plus a re-read. Storage is unreadable during
 *  render (SSR) and a slot may mount after the reader did, so the list is read
 *  on mount and again whenever the caller asks. */
export function useKnownSlots(): [SlotNote[], () => void] {
  const [slots, setSlots] = useState<SlotNote[]>([]);
  const reread = useCallback(() => { setSlots(knownSlots()); }, []);
  useEffect(() => { reread(); }, [reread]);
  return [slots, reread];
}

export function AddToPicker({ appId }: { appId: string }) {
  const { client } = useVendoProvider();
  const [slots, rereadSlots] = useKnownSlots();
  const [open, setOpen] = useState(false);
  const [placedIn, setPlacedIn] = useState<string>();
  const [failed, setFailed] = useState(false);

  const toggle = () => {
    rereadSlots();
    setFailed(false);
    setOpen(current => !current);
  };

  const choose = async (slot: SlotNote) => {
    try {
      await client.apps.place(appId, slot.id);
      // Every mounted slot re-reads on the announcement instead of waiting out
      // its poll floor (pin-events.ts).
      announcePin(appId);
      setPlacedIn(slot.label);
      setOpen(false);
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
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 17v5M9 3h6l-1 7 3 3H7l3-3-1-7Z" />
        </svg>
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
