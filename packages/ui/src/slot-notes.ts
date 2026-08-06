/**
 * The slots this origin has seen mounted — the "Add to…" picker's only source
 * of destinations.
 *
 * A slot id is the HOST's markup, not a Vendo document: nothing on the server
 * knows a slot exists until something is placed in it. So the picker (which
 * lives in an app embed, on whatever page the host renders a chat) can only
 * learn about a slot from a mounted `VendoSlot` saying so. localStorage —
 * origin-scoped, exactly like discoverability's seen-marks — is what carries
 * that across the navigation from the dashboard to the chat page.
 *
 * Module-level like pin-events.ts, and for the same reason: the announcer (a
 * slot in the host's page) and the listener (a picker in a chat surface) share
 * no React tree.
 */

const KEY = "vendo.slots";

export interface SlotNote {
  /** The slot's `id` — the value that goes over the wire as a placement. */
  id: string;
  /** What a person choosing a destination reads. */
  label: string;
}

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function read(): SlotNote[] {
  try {
    const raw = storage()?.getItem(KEY);
    if (raw === null || raw === undefined || raw === "") return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((note): note is SlotNote =>
      typeof note === "object" && note !== null
      && typeof (note as SlotNote).id === "string"
      && typeof (note as SlotNote).label === "string");
  } catch {
    // Denied storage, or a value another tool wrote under our key. Neither is
    // recoverable and neither is worth a broken picker: no slots is a state the
    // picker already renders (it hides).
    return [];
  }
}

/** Record that a slot exists on this origin. Idempotent; a remount with a new
 *  label updates it in place. Best-effort — a refused write leaves the picker
 *  with whatever it already knew. */
export function noteSlot(note: SlotNote): void {
  const known = read();
  const existing = known.find(item => item.id === note.id);
  if (existing !== undefined && existing.label === note.label) return;
  const next = existing === undefined
    ? [...known, note]
    : known.map(item => (item.id === note.id ? note : item));
  try {
    storage()?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota / denied — the picker keeps the slots it already knows */
  }
}

/** Every slot this origin has mounted, in the order they were first seen. */
export function knownSlots(): SlotNote[] {
  return read();
}
