import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { useVendoContext } from "../context.js";
import { toolTitle, type ToolMeta } from "./humanize.js";

/**
 * The thread's in-progress presentation speaks in the product's voice: each
 * tool call renders as a quiet human "beat" — a checklist line with a pulsing
 * orb while working and a tick when done. Labels come from the ENG-216
 * humanization pipeline (host `ToolMeta` wins, else the prettified tool id —
 * never the raw slug or a lifecycle string). The mechanical record stays in
 * the Activity panel.
 */

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

function rawToolName(part: AnyToolPart): string {
  return part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
}

/** Connector tools ("slack_SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL") → toolkit slug. */
export function toolkitFromToolName(name: string): string | undefined {
  const match = /^([a-z]+)_[A-Z0-9_]+$/.exec(name) ?? /^([A-Z]+)_[A-Z0-9_]+$/.exec(name);
  return match ? match[1]!.toLowerCase() : undefined;
}

/** Toolkit domains with clean, recognizable marks (chrome surfaces only — the jail blocks remote images). */
const TOOLKIT_DOMAINS: Record<string, string> = {
  slack: "slack.com",
  gmail: "gmail.com",
  googlecalendar: "calendar.google.com",
  github: "github.com",
  notion: "notion.so",
  linear: "linear.app",
};

export function toolkitLogoUrl(toolkit: string): string | undefined {
  const domain = TOOLKIT_DOMAINS[toolkit];
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : undefined;
}

/**
 * The consent-surface presentation of one tool call, layered on the ENG-216
 * pipeline: the title is the humanized tool label (host meta wins), the
 * eyebrow marks an automation when the REAL inputs carry a recurrence
 * (`trigger`/`every`/`schedule`), and the description explains what granting
 * means in plain words — host meta first, else synthesized from the inputs,
 * never invented beyond them.
 */
export interface ToolPresentation {
  title: string;
  eyebrow: string;
  description?: string;
  /** Short toast byline for the post-approve notification. */
  sub?: string;
  toolkit?: string;
  logoUrl?: string;
}

export function toolPresentation(name: string, args?: unknown, meta?: ToolMeta): ToolPresentation {
  const toolkit = toolkitFromToolName(name);
  const logoUrl = toolkit ? toolkitLogoUrl(toolkit) : undefined;
  const flat = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const trigger = typeof flat.trigger === "string" ? flat.trigger
    : typeof flat.every === "string" ? `every ${flat.every}`
    : typeof flat.schedule === "string" ? flat.schedule
    : undefined;
  const eyebrow = trigger ? "Automation · needs your approval" : "Needs your approval";
  const title = toolTitle(name, meta);

  let description = meta?.description;
  let sub: string | undefined;
  if (toolkit === "slack" && typeof flat.channel === "string") {
    description ??= trigger
      ? `Vendo will post to ${flat.channel} on your behalf, ${trigger}. It runs as you, and you can pause it anytime.`
      : `Vendo will post to ${flat.channel} on your behalf, running as you.`;
    sub = trigger ? `Posts to ${flat.channel} ${trigger}` : `Posts to ${flat.channel} as you`;
  } else if (toolkit === "gmail" && typeof flat.to === "string") {
    description ??= `Vendo will send this email as you${trigger ? `, ${trigger}` : ""}.`;
    sub = `Emails ${flat.to} as you`;
  }
  return { title, eyebrow, description, sub, toolkit, logoUrl };
}

export function BuildBeat({
  part,
  risk,
  count = 1,
}: {
  part: AnyToolPart;
  risk: string;
  /** Collapsed-run repeat count (ENG-216) — shown as a ×N suffix. */
  count?: number;
}) {
  const { tools } = useVendoContext();
  const name = rawToolName(part);
  const error = part.state === "output-error";
  const done = part.state === "output-available";
  const waiting = part.state === "approval-requested";
  const label = toolTitle(name, tools[name]);
  const state = error ? "fl-beat-error" : done ? "fl-beat-done" : "fl-beat-working";
  return (
    <div
      className={`fl-beat ${state}`}
      data-vendo-approval={risk}
      data-vendo-tool={name}
      title={name}
    >
      {error ? (
        <span className="fl-beat-ic fl-beat-x" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </span>
      ) : done ? (
        <span className="fl-beat-ic fl-beat-tick" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 12 4 4L19 6" />
          </svg>
        </span>
      ) : (
        <span className="fl-beat-orb" aria-hidden="true" />
      )}
      <span className="fl-beat-label">
        {label}
        {waiting ? " — waiting for your approval" : error ? " — couldn't finish" : done ? "" : "…"}
      </span>
      {count > 1 ? <span className="fl-beat-count" aria-label={`repeated ${count} times`}>×{count}</span> : null}
    </div>
  );
}
