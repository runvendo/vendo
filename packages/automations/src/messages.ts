/**
 * §9.9's stop sentences, in one place — the list, the fire-time gate and the
 * stopped run row all print them and have to match byte for byte.
 *
 * Lifted out of engine.ts unchanged.
 */
import type { Sponsorship } from "./sponsorship.js";

/** Every stop sentence ends the same way, and must: the list and the stopped run
 *  row both print it, and they have to match byte for byte. */
const TAKE_IT_ON = " — anyone who can edit this app can turn it back on";

/** §9.9 — what a stopped automation says, in the consumer's voice. It names the
 *  automation and what anyone who can edit the app may do about it; the
 *  machinery (hashes, grants, principals) stays out of the sentence.
 *
 *  It never names the SPONSOR, and that is a durability rule rather than a
 *  style one: this sentence is PERSISTED on the run row, `vendo_runs` has no
 *  subject column (02-store §2), and the erase cascade reaches run rows only
 *  through the apps the subject OWNS — which for an org-owned automation is the
 *  org, and the org outlives the person (§9.7). A name written here would
 *  therefore survive its owner's own erasure. The name belongs on the audit row
 *  instead: it is derived from rows the cascade does reach. */
const SPONSORSHIP_STOP: Record<NonNullable<Sponsorship["reason"]>, (name: string) => string> = {
  edit: (name) => `stopped: ${name} changed after the person who set it up allowed it${TAKE_IT_ON}`,
  departure: (name) => `stopped: the person ${name} ran as no longer has access to it${TAKE_IT_ON}`,
  grants: (name) => `stopped: the permissions ${name} ran with were removed${TAKE_IT_ON}`,
};

/** The stopped shape three surfaces read: the reason, and the one sentence that
 *  goes with it. Built here so the list, the gate and the card cannot drift. */
export const stopFor = (
  reason: NonNullable<Sponsorship["reason"]>,
  automationName: string,
): { reason: NonNullable<Sponsorship["reason"]>; summary: string } =>
  ({ reason, summary: SPONSORSHIP_STOP[reason](automationName) });

/** §9.9 — what a run says when the identity checks could not ANSWER (the
 *  host's memberships callback or access seam threw). The raw failure is a host
 *  system's error text — a DSN, a stack, a driver message — and the run row is
 *  rendered verbatim to consumers (`automations-panel.tsx` prints `summary` and
 *  `error.message`), so it says what happened and nothing about how. The raw
 *  detail goes to the audit row, which is where an operator looks. */
export const IDENTITY_UNAVAILABLE = (name: string): string =>
  `stopped: ${name} could not check who it runs as — nothing ran, and it will try again on its next trigger`;
