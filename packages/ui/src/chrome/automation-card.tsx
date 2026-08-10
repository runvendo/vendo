import type { Trigger } from "@vendoai/core";
import { CardLine, CardShell, TICK_GLYPH } from "./card-shell.js";
import { ChromeRoot } from "./chrome-root.js";
import { humanizeToolName } from "./humanize.js";

/** 2026-07 demo feedback — the automation, rendered AS an automation.
 *
 * The `data-vendo-automation` stream part lands one of these in the transcript
 * when a turn creates or arms an automation. No toggle, no run history, no
 * dry-run controls: management stays in the workspace Automations panel; the
 * thread card is the moment's record.
 *
 * A1 · Sentence + E3 · Rule list — the sentence family the approval card
 * opened: the RULE is the title ("New PG&E bill → paid from Maple Checking"),
 * one quiet status line under it says whether it is on and whose access it
 * runs with, and the agent's own rule sentences follow as a tick list. The
 * eyebrow, the bolt well and the trigger → action node diagram are gone — the
 * diagram said in two boxes what the title now says in one line.
 */

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** "0 17 * * 5" → "Fridays at 5:00 PM"; "0 8 * * *" → "Daily at 8:00 AM".
    Only the simple fixed-time forms humanize — anything else (ranges, lists,
    step values) returns null and the raw cron stays the honest label.

    The clock this returns is BARE, with no zone: the engine evaluates every
    cron in UTC, and naming the zone is the render site's job (see
    {@link triggerLabel}) so the mapping itself stays a pure cron→clock read. */
export function humanizeCron(cron: string): string | null {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|\d)$/.exec(cron.trim());
  if (!match) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  const clock = `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
  if (match[3] === "*") return `Daily at ${clock}`;
  const day = DAY_NAMES[Number(match[3]) % 7];
  return `${day} at ${clock}`;
}

/** One clause of the card, at the length a card can hold. The rule sentence's
    action half has always clamped here (an agentic prompt is arbitrarily long);
    the authored rule list clamps the same way, so no producer can push the card
    past its own geometry. */
const clamp = (text: string): string =>
  text.length > 68 ? `${text.slice(0, 67).trimEnd()}…` : text;

export function triggerLabel(trigger: Trigger): string {
  const source = trigger.on;
  if (source.kind === "schedule") {
    if (source.every) return `Every ${source.every}`;
    if (source.at) return source.at;
    // The zone is named because the automation does not fire in the reader's:
    // the engine builds every cron with `{ timezone: "UTC" }`, so an 8 AM
    // Pacific request is stored as 16:00 and an unlabelled "Mondays at 4:00 PM"
    // reads as the reader's own afternoon — eight hours off, with nothing on
    // screen to say so. Only the humanized CLOCK is labelled; a raw cron
    // expression shows no hour to misplace, and `at` is an ISO instant that
    // carries its own zone.
    if (source.cron) {
      const clock = humanizeCron(source.cron);
      return clock === null ? source.cron : `${clock} UTC`;
    }
    return "Scheduled";
  }
  return humanizeToolName(source.event);
}

/** The rule this automation runs by, as one sentence: what starts it → what it
    then does. The card's title when the document wrote no description of its
    own. (It replaced a two-box `trigger → action` diagram, whose second labels
    — "Schedule", "1 action", "N steps" — named the boxes, not the rule, and
    went with them.) */
export function automationRule(trigger: Trigger | undefined): string | undefined {
  if (!trigger) return undefined;
  const action = trigger.run.kind === "agentic"
    ? trigger.run.prompt.trim()
    : trigger.run.steps[0] === undefined ? "" : humanizeToolName(trigger.run.steps[0].tool);
  return action.length === 0 ? undefined : `${triggerLabel(trigger)} → ${clamp(action)}`;
}

/** How many of an automation's terms a CARD shows, and how long each may be.
    A card is the moment's record, not the settings page — the Automations panel
    owns the full list — so the render is bounded no matter what the document
    says. Blanks and non-strings drop here rather than upstream: the schema lets
    them through on purpose, so one sloppy sentence can never cost the whole
    automation card (see `Trigger.rules`). */
const MAX_RULES = 6;

function automationRules(rules: readonly string[]): string[] {
  return rules
    .filter((rule): rule is string => typeof rule === "string")
    .map(rule => rule.trim())
    .filter(rule => rule.length > 0)
    .slice(0, MAX_RULES)
    .map(clamp);
}

export interface AutomationCardProps {
  /** The automation document's display name. */
  name: string;
  /** Whether the automations engine reports it enabled. */
  enabled: boolean;
  /** The document's trigger: the source of the rule sentence AND of the terms
   *  it runs by (`Trigger.rules`). Omitted → the name is all this card has. */
  trigger?: Trigger;
  /** The document's one-line description. Preferred over the composed
   *  `trigger → action` title: it is the human phrasing of the same rule. */
  description?: string;
  /** E3 — the automation's terms, one sentence each ("Caps at $200 a bill —
   *  anything higher asks you first"), as a tick list under the status line;
   *  omitted entirely when there are none. Defaults to the trigger's own
   *  `rules`, which is where the document carries them and how the wire's
   *  automation part delivers them — a host mounting this card from its own
   *  data passes them here instead. */
  rules?: string[];
  /** Standing-grant asks still undecided (grant sets): the state line reads
   *  "Enabled · waiting on N permissions" until the set is granted. */
  pendingGrants?: number;
  /** §13 — the automation's sponsor: it always runs as a named person, and the
   *  window says whose access that is. */
  sponsor?: { subject: string; display?: string };
  /** How many principals can reach the app, when that is knowable. */
  editors?: number;
}

/** §13's window label — "runs with Dana's access", and the wider editor set
 *  when one exists. The subject is the honest fallback: Vendo holds no
 *  directory, so a display name for anyone but the caller would be invented. */
export function sponsorLabel(
  sponsor: { subject: string; display?: string } | undefined,
  editors?: number,
): string | null {
  if (sponsor === undefined) return null;
  const who = `Runs with ${sponsor.display ?? sponsor.subject}'s access`;
  return editors !== undefined && editors > 1 ? `${who} · ${editors} people can edit` : who;
}

/** The read-only automation card (the thread's record of a live automation). */
export function AutomationCard({ name, enabled, trigger, description, rules, pendingGrants = 0, sponsor, editors }: AutomationCardProps) {
  const waiting = enabled && pendingGrants > 0;
  // Law 3 and the title are ONE line now: the rule itself. The description is
  // the human phrasing of that rule and wins when the document wrote one — a
  // BLANK one is not a phrasing, and as the card's 14px title an empty string
  // is a headless card, where as the old quiet line it was merely a gap. The
  // composed trigger → action is the honest fallback, and a document with
  // neither is only its name. The NAME is still the card's accessible name.
  const described = (description ?? "").trim();
  const rule = described.length > 0 ? described : automationRule(trigger) ?? name;
  const terms = automationRules(rules ?? trigger?.rules ?? []);
  // Whether it is on, and whose access it runs with — the state chip and the
  // byline row, folded into one quiet line. " · " is literal here (unlike the
  // approval notes) because these are clauses of one sentence about one thing.
  const state = [
    enabled
      ? waiting ? `Enabled · waiting on ${pendingGrants} permission${pendingGrants === 1 ? "" : "s"}` : "Enabled"
      : "Disabled",
    sponsorLabel(sponsor, editors),
  ].filter(clause => clause !== null).join(" · ");
  return (
    <ChromeRoot>
      <CardShell label={`Automation — ${name}`} className="fl-automation" data-vendo-automation-card="">
        <CardLine className="fl-auto-sentence">{rule}</CardLine>
        <div className="fl-auto-state">
          {enabled ? <span className={`fl-auto-live${waiting ? " fl-auto-wait" : ""}`} aria-hidden="true" /> : null}
          <span className="fl-auto-state-copy">{state}</span>
        </div>
        {/* A real list: these are N distinct promises about how the automation
            behaves, and a reader has to be able to step through them. */}
        {terms.length === 0 ? null : (
          <ul className="fl-auto-rules" aria-label={`Rules for ${name}`}>
            {terms.map((sentence, index) => <li key={index}>{TICK_GLYPH}{sentence}</li>)}
          </ul>
        )}
      </CardShell>
    </ChromeRoot>
  );
}
