/** The slot registry's input bounds, in ONE place because two blocks enforce
 *  them and a drift between the two is invisible: the client cleans a page's
 *  report to fit (`packages/ui/src/hooks/use-placements.ts`), and the wire
 *  refuses anything past them (`packages/vendo/src/wire/slots.ts`), which stays
 *  the strict backstop for every other caller. */

/** Longest slot id a report may carry; an id outside 1-this is not a slot. */
export const SLOT_ID_MAX_CHARS = 256;

/** Longest slot label a report may carry. */
export const SLOT_LABEL_MAX_CHARS = 256;

/** Most slots one report may carry — no page mounts more than this. */
export const SLOTS_REPORT_MAX = 200;
