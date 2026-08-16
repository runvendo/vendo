/** The slot registry's input bounds, in ONE place because two blocks enforce
 *  them and a drift between the two is invisible: the client cleans a page's
 *  report to fit (`packages/ui/src/hooks/use-placements.ts`), and the wire
 *  refuses anything past them (`packages/vendo/src/wire/slots.ts`), which stays
 *  the strict backstop for every other caller. */

/** Longest slot id a report may carry; an id outside 1-this is not a slot. */
export const SLOT_ID_MAX_CHARS = 256;

/** Longest slot label a report may carry. */
export const SLOT_LABEL_MAX_CHARS = 256;

/** Longest slot description a report may carry. Roomier than a label because it
 *  is a sentence of intent for the MODEL to read ("main dashboard area, where
 *  users keep KPI views"), not a word a person picks from a menu. */
export const SLOT_DESCRIPTION_MAX_CHARS = 1024;

/** Most slots one report may carry — no page mounts more than this. */
export const SLOTS_REPORT_MAX = 200;

/** How long a slot stays in the registry after the last render that reported
 *  it. Long enough that a page nobody visited for a month still counts, short
 *  enough that a slot deleted from the codebase stops being offered. */
export const SLOT_DECAY_MS = 30 * 24 * 60 * 60 * 1000;

/** How long the client trusts its own "already reported" note before it reports
 *  a still-mounted slot again. It is here, beside the decay window, because the
 *  two are ONE invariant: a client that outlives {@link SLOT_DECAY_MS} without
 *  re-reporting watches its own mounted slot age out of the registry and vanish
 *  from the "Add to…" picker. Far enough under it that a slow month of tab-alive
 *  browsing never gets close, far enough over a page load that ordinary
 *  navigation still writes nothing. */
export const SLOT_REPORT_REFRESH_MS = 24 * 60 * 60 * 1000;
