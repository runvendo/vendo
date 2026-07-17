import type { DynamicToolUIPart, ToolUIPart } from "ai";

/**
 * The thread's in-progress presentation speaks in the product's voice, not
 * the agent's: each tool call renders as a quiet human "beat" ("Reading your
 * deadlines…"), never a raw transcript chip. The full mechanical record —
 * tool ids, inputs, outcomes, deciders — stays in the Activity panel, which
 * is the audit surface for exactly this.
 */

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

function rawToolName(part: AnyToolPart): string {
  return part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
}

/** "listDeadlines" | "list_deadlines" → ["list", "deadlines"] */
function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

const VERBS: Record<string, string> = {
  list: "Reading",
  get: "Reading",
  read: "Reading",
  fetch: "Reading",
  search: "Searching",
  find: "Searching",
  create: "Creating",
  add: "Adding",
  send: "Sending",
  post: "Posting",
  update: "Updating",
  set: "Updating",
  edit: "Updating",
  delete: "Removing",
  remove: "Removing",
  upload: "Uploading",
};

/** Vendo's own tools narrate the build itself. */
const VENDO_LABELS: Array<[RegExp, string]> = [
  [/^vendo_apps_create$/, "Building your view"],
  [/^vendo_apps_edit$/, "Refining your view"],
  [/^vendo_apps_(fork|rebase_pin)$/, "Remixing from your product"],
  [/^vendo_apps_/, "Shaping your view"],
  [/^vendo_automations_/, "Wiring the schedule"],
  [/^vendo_/, "Working on it"],
];

/** "slack_SLACK_SEND_MESSAGE" | "GMAIL_SEND_EMAIL" → the connector toolkit slug. */
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

/** Connector tools ("slack_SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL") → toolkit voice. */
function connectorLabel(name: string): string | undefined {
  const toolkit = toolkitFromToolName(name);
  if (!toolkit) return undefined;
  const pretty = toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
  const rest = tokens(name.slice(toolkit.length + 1));
  const verb = rest.find(token => VERBS[token]);
  if (verb === "send" || verb === "post") return `Posting to ${pretty}`;
  if (verb) return `${VERBS[verb]} in ${pretty}`;
  return `Using ${pretty}`;
}

/**
 * The consent-surface presentation of one tool call: a human title, an
 * eyebrow (an automation reads differently from a one-off action), an
 * optional plain-language description of what granting means, and the toolkit
 * mark. `args` sharpen the copy where they safely can — never invented,
 * always from the real inputs. An `every`/`trigger`/`schedule` input marks
 * the call as an automation the grant will keep running.
 */
export interface ToolPresentation {
  title: string;
  eyebrow: string;
  description?: string;
  toolkit?: string;
  logoUrl?: string;
}

export function toolPresentation(name: string, args?: unknown): ToolPresentation {
  const toolkit = toolkitFromToolName(name);
  const logoUrl = toolkit ? toolkitLogoUrl(toolkit) : undefined;
  const flat = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const trigger = typeof flat.trigger === "string" ? flat.trigger
    : typeof flat.every === "string" ? `every ${flat.every}`
    : typeof flat.schedule === "string" ? flat.schedule
    : undefined;
  const eyebrow = trigger ? "Automation · needs your approval" : "Needs your approval";

  if (toolkit === "slack" && typeof flat.channel === "string") {
    const pretty = flat.channel;
    return {
      title: `Post to ${pretty} in Slack`,
      eyebrow,
      description: trigger
        ? `Vendo will post to ${pretty} on your behalf, ${trigger}. It runs as you, and you can pause it anytime.`
        : `Vendo will post to ${pretty} on your behalf, running as you.`,
      toolkit,
      logoUrl,
    };
  }
  if (toolkit === "gmail" && typeof flat.to === "string") {
    return {
      title: `Email ${flat.to} from Gmail`,
      eyebrow,
      description: `Vendo will send this email as you${trigger ? `, ${trigger}` : ""}.`,
      toolkit,
      logoUrl,
    };
  }
  const label = connectorLabel(name);
  if (toolkit && label) return { title: label, eyebrow, toolkit, logoUrl };
  return { title: beatLabel({ type: `tool-${name}` } as AnyToolPart), eyebrow };
}

/** One tool call, in plain words: "host_listDeadlines" → "Reading your deadlines". */
export function beatLabel(part: AnyToolPart): string {
  const name = rawToolName(part);
  for (const [pattern, label] of VENDO_LABELS) {
    if (pattern.test(name)) return label;
  }
  const connector = connectorLabel(name);
  if (connector) return connector;
  const words = tokens(name.replace(/^host_/, ""));
  if (words.length === 0) return "Working on it";
  // Verb-first ("listDeadlines") or verb-last ("email_send") both occur in
  // host APIs; take whichever token we recognize.
  const verbIndex = words.findIndex(word => VERBS[word]);
  if (verbIndex === -1) return `Working on ${words.join(" ")}`;
  const verb = VERBS[words[verbIndex]!]!;
  const noun = [...words.slice(0, verbIndex), ...words.slice(verbIndex + 1)].join(" ");
  return noun ? `${verb} your ${noun}` : verb;
}

export function BuildBeat({
  part,
  risk,
}: {
  part: AnyToolPart;
  risk: string;
}) {
  const error = part.state === "output-error";
  const done = part.state === "output-available";
  const waiting = part.state === "approval-requested";
  const label = beatLabel(part);
  const state = error ? "fl-beat-error" : done ? "fl-beat-done" : "fl-beat-working";
  return (
    <div
      className={`fl-beat ${state}`}
      data-vendo-approval={risk}
      data-vendo-tool={rawToolName(part)}
      title={rawToolName(part)}
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
    </div>
  );
}
