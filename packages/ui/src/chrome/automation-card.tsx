import type { Trigger } from "@vendoai/core";
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
    step values) returns null and the raw cron stays the honest label. */
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
    if (source.cron) return { title: humanizeCron(source.cron) ?? source.cron, sub: "Schedule" };
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
}

/** The read-only automation card (same chrome as the panel's list entry). */
export function AutomationCard({ name, enabled, trigger, description }: AutomationCardProps) {
  const flow = automationFlow(trigger);
  return (
    <ChromeRoot>
      <article className="fl-automation" data-vendo-automation-card="" aria-label={`Automation — ${name}`}>
        <div className="fl-auto-head">
          <span className="fl-auto-ic" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m13 2-9 12h8l-1 8 9-12h-8l1-8Z" />
            </svg>
          </span>
          <div>
            <div className="fl-auto-title">{name}</div>
            <div className="fl-auto-sub">
              {enabled ? <span className="fl-auto-live" aria-hidden="true" /> : null}
              {enabled ? "Enabled" : "Disabled"}
            </div>
            {description ? <div className="fl-auto-sub" style={{ display: "block" }}>{description}</div> : null}
          </div>
        </div>
        {flow ? (
          <div className="fl-auto-flow" aria-label={`Automation flow for ${name}`}>
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
      </article>
    </ChromeRoot>
  );
}
