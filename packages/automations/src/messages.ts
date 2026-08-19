/**
 * §9.9's stop sentences, in one place — the list, the fire-time gate and the
 * stopped run row all print them and have to match byte for byte.
 */
import { humanizeToolName, type AutomationRecord } from "@vendoai/core";
import type { Sponsorship } from "./sponsorship.js";

/** What to CALL an automation in a sentence a person reads. A record has no
 *  name field — it is a task, so the task is the name. Capped, because this
 *  goes inside a sentence and a goal prompt can be a paragraph.
 *
 *  A goal's prompt is already a person's words; a step's tool is an IDENTIFIER,
 *  and design §3's voice law is that no surface prints one at someone — so it
 *  arrives through the same prettifier chrome titles a tool chip with. */
export const automationName = (record: AutomationRecord): string => {
  const text = record.task.kind === "goal"
    ? record.task.prompt.trim()
    : humanizeToolName(record.task.steps[0]?.tool ?? "");
  return text.length <= 60 ? text || record.id : `${text.slice(0, 59)}…`;
};

/** Every stop sentence ends the same way, and must: the list and the stopped run
 *  row both print it, and they have to match byte for byte. */
const TAKE_IT_ON = " — anyone who holds this automation can turn it back on";

/** §9.9 — what a stopped automation says, in the consumer's voice. It names the
 *  automation and what may be done about it; the machinery (hashes, grants,
 *  principals) stays out of the sentence.
 *
 *  It never names the SPONSOR, and that is a durability rule rather than a style
 *  one: this sentence is PERSISTED on the run row, and a name written here would
 *  survive its owner's own erasure. The name belongs on the audit row instead:
 *  it is derived from rows the erase cascade does reach. */
const SPONSORSHIP_STOP: Record<NonNullable<Sponsorship["reason"]>, (name: string) => string> = {
  edit: (name) => `stopped: "${name}" changed after the person who set it up allowed it${TAKE_IT_ON}`,
  departure: (name) => `stopped: the person "${name}" ran as no longer has access to it${TAKE_IT_ON}`,
};

/** The stopped shape three surfaces read: the reason, and the one sentence that
 *  goes with it. Built here so the list, the gate and the card cannot drift. */
export const stopFor = (
  reason: NonNullable<Sponsorship["reason"]>,
  record: AutomationRecord,
): { reason: NonNullable<Sponsorship["reason"]>; summary: string } =>
  ({ reason, summary: SPONSORSHIP_STOP[reason](automationName(record)) });

/** §9.9 — what a run says when the identity checks could not ANSWER (the host's
 *  memberships callback threw). The raw failure is a host system's error text —
 *  a DSN, a stack, a driver message — and the run row is rendered verbatim to
 *  consumers, so it says what happened and nothing about how. The raw detail
 *  goes to the audit row, which is where an operator looks. */
export const IDENTITY_UNAVAILABLE = (name: string): string =>
  `stopped: "${name}" could not check who it runs as — nothing ran, and it will try again on its next trigger`;

/** The fire-time miss the runner map cannot resolve. LOUD by construction: it
 *  lands as a FAILED run row naming the name nobody registered, because a
 *  fallback brain would run someone's automation through an agent they never
 *  named and nobody would ever find out. */
export const NO_SUCH_RUNNER = (name: string): string =>
  `stopped: no agent named "${name}" is registered in this deployment — nothing ran`;

/**
 * The one phrase every read an automation may make is named by, together.
 *
 * Reads are the bulk of any automation's surface and the least interesting thing
 * about it: naming them one by one is what turned a person's yes to a JOB into a
 * wall of tool names they could not act on (live 2026-08-18 — three of the four
 * follow-up asks were reads). They still get granted, they are simply not worth a
 * line each. Deliberately generic and deliberately not a list: it says what the
 * automation can SEE, in the words someone would use about their own account,
 * with no tool identifier anywhere near it.
 */
export const READ_ONLY_POWER = "Read-only access to your data";

/**
 * What a person is told an automation will hold, in the order they should read
 * it: the tools that DO something, each by its own human title, then every read
 * folded into {@link READ_ONLY_POWER}.
 *
 * Titles, never identifiers (design §3's voice law) — a descriptor with no title
 * falls back to its name, which is the same fallback every other consent surface
 * makes. The list is what rides on the arming approval (`ApprovalRequest.powers`),
 * so it is a plain array of finished phrases: every surface renders it verbatim
 * and none of them has to know this rule.
 */
export const powerTitles = (
  powers: ReadonlyArray<{ descriptor: { name: string; title?: string; risk: string } }>,
): string[] => {
  const acts = powers
    .filter(({ descriptor }) => descriptor.risk !== "read")
    .map(({ descriptor }) => descriptor.title ?? descriptor.name);
  const reads = powers.some(({ descriptor }) => descriptor.risk === "read");
  return reads ? [...acts, READ_ONLY_POWER] : acts;
};
