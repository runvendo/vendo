import type { Trigger } from "@vendoai/core";
import {
  BOLT_GLYPH,
  CardByline,
  CardHead,
  CardLine,
  CardShell,
  CARD_EYEBROWS,
  ToolkitLogo,
} from "./card-shell.js";
import { ChromeRoot } from "./chrome-root.js";
import { humanizeToolName } from "./humanize.js";

/** 2026-07 demo feedback — the automation, rendered AS an automation.
 *
 * The workspace Automations panel already ships the card vocabulary
 * (.fl-automation: identity head + trigger → action flow nodes); this module
 * extracts the read-only core so the THREAD can render it too — the
 * `data-vendo-automation` stream part lands one of these in the transcript
 * when a turn creates or arms an automation. No toggle, no run history, no
 * dry-run controls: management stays in the panel; the thread card is the
 * moment's record.
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

export function triggerLabel(trigger: Trigger): { title: string; sub: string } {
  const source = trigger.on;
  if (source.kind === "schedule") {
    if (source.every) return { title: `Every ${source.every}`, sub: "Schedule" };
    if (source.at) return { title: source.at, sub: "Scheduled once" };
    // The zone is named because the automation does not fire in the reader's:
    // the engine builds every cron with `{ timezone: "UTC" }`, so an 8 AM
    // Pacific request is stored as 16:00 and an unlabelled "Mondays at 4:00 PM"
    // reads as the reader's own afternoon — eight hours off, with nothing on
    // screen to say so. Only the humanized CLOCK is labelled; a raw cron
    // expression shows no hour to misplace, and `at` is an ISO instant that
    // carries its own zone.
    if (source.cron) {
      const clock = humanizeCron(source.cron);
      return { title: clock === null ? source.cron : `${clock} UTC`, sub: "Schedule" };
    }
    return { title: "Scheduled", sub: "Schedule" };
  }
  if (source.kind === "external") {
    return { title: humanizeToolName(source.event), sub: humanizeToolName(source.connector) };
  }
  return { title: humanizeToolName(source.event), sub: "Host event" };
}

export function automationFlow(trigger: Trigger | undefined): {
  trigger: { title: string; sub: string };
  action: { title: string; sub: string };
} | undefined {
  if (!trigger) return undefined;
  if (trigger.run.kind === "agentic") {
    const prompt = trigger.run.prompt.trim();
    if (!prompt) return undefined;
    return {
      trigger: triggerLabel(trigger),
      action: {
        title: prompt.length > 68 ? `${prompt.slice(0, 67).trimEnd()}…` : prompt,
        sub: "Agent run",
      },
    };
  }
  const firstStep = trigger.run.steps[0];
  if (!firstStep) return undefined;
  return {
    trigger: triggerLabel(trigger),
    action: {
      title: humanizeToolName(firstStep.tool),
      sub: trigger.run.steps.length === 1 ? "1 action" : `${trigger.run.steps.length} steps`,
    },
  };
}

export interface AutomationCardProps {
  /** The automation document's display name. */
  name: string;
  /** Whether the automations engine reports it enabled. */
  enabled: boolean;
  /** The document's trigger, for the flow nodes; omitted → identity only. */
  trigger?: Trigger;
  /** The document's one-line description. */
  description?: string;
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

/** The read-only automation card (same chrome as the panel's list entry). */
export function AutomationCard({ name, enabled, trigger, description, pendingGrants = 0, sponsor, editors }: AutomationCardProps) {
  const flow = automationFlow(trigger);
  const waiting = enabled && pendingGrants > 0;
  const runsAs = sponsorLabel(sponsor, editors);
  return (
    <ChromeRoot>
      <CardShell label={`Automation — ${name}`} className="fl-automation" data-vendo-automation-card="">
        <CardHead
          icon={<ToolkitLogo fallback={BOLT_GLYPH} />}
          eyebrow={CARD_EYEBROWS.automationStatus}
          title={name}
          aside={
            <span className="fl-auto-sub" style={{ marginLeft: "auto" }}>
              {enabled ? <span className={`fl-auto-live${waiting ? " fl-auto-wait" : ""}`} aria-hidden="true" /> : null}
              {enabled
                ? waiting
                  ? `Enabled · waiting on ${pendingGrants} permission${pendingGrants === 1 ? "" : "s"}`
                  : "Enabled"
                : "Disabled"}
            </span>
          }
        />
        {/* Law 3 — what this automation DOES, in the user's words. */}
        <CardLine>{description ?? (flow ? `${flow.trigger.title} → ${flow.action.title}` : name)}</CardLine>
        {runsAs === null ? null : <CardByline>{runsAs}</CardByline>}
        {/* role="group": a bare <div> may not carry aria-label
            (aria-prohibited-attr). The panel's copy of this node was fixed at
            integration; the thread's copy was not. */}
        {flow ? (
          <div className="fl-auto-flow" role="group" aria-label={`Automation flow for ${name}`}>
            <span className="fl-auto-node" style={{ flex: 1 }}>
              <span className="fl-auto-node-ic" aria-hidden="true">↳</span>
              <span>
                <span className="fl-auto-node-t">{flow.trigger.title}</span>
                <span className="fl-auto-node-s" style={{ display: "block" }}>{flow.trigger.sub}</span>
              </span>
            </span>
            <span className="fl-auto-arrow" aria-hidden="true" />
            <span className="fl-auto-node" style={{ flex: 1 }}>
              <span className="fl-auto-node-ic" aria-hidden="true">✓</span>
              <span>
                <span className="fl-auto-node-t">{flow.action.title}</span>
                <span className="fl-auto-node-s" style={{ display: "block" }}>{flow.action.sub}</span>
              </span>
            </span>
          </div>
        ) : null}
      </CardShell>
    </ChromeRoot>
  );
}
