/**
 * The automation card (spec section d, content outline approved; visual
 * treatment reuses the approval-card patterns — Yousef-gated).
 *
 * Proposal state: the create/update approval. The user sees a plain-language
 * summary of when the automation runs, what it will do, and which app actions
 * can run automatically. The raw spec is one disclosure away for inspection.
 *
 * The shell deliberately does not import the automations engine: the card
 * parses the tool-call input defensively and falls back to the generic
 * approval JSON dump when the shape is unfamiliar.
 */
import { ApprovalCard } from "./ApprovalCard";
import { BrandIcon } from "./BrandIcon";
import { humanize, toolAction } from "./tool-labels";

/** The authoring tools whose approvals render as this card. */
export function isAutomationApproval(toolName: string): boolean {
  return toolName === "create_automation" || toolName === "update_automation";
}

interface StepLike {
  id: string;
  type: string;
  tool?: string;
  goal?: string;
  tools?: string[];
  input?: Record<string, unknown>;
  if?: string;
  then?: StepLike[];
  else?: StepLike[];
  steps?: StepLike[];
  items?: string;
}

interface SpecLike {
  name: string;
  description?: string;
  prompt?: string;
  if?: string;
  trigger: { type: string } & Record<string, unknown>;
  execution: { mode: string; steps?: StepLike[]; goal?: string; tools?: string[] };
}

function parseSpec(input: unknown): { spec: SpecLike; grantedTools: string[] } | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as { spec?: unknown; grantedTools?: unknown };
  const spec = record.spec as SpecLike | undefined;
  if (
    spec === null ||
    spec === undefined ||
    typeof spec !== "object" ||
    typeof spec.name !== "string" ||
    typeof spec.trigger?.type !== "string" ||
    typeof spec.execution?.mode !== "string"
  ) {
    return undefined;
  }
  const grantedTools = Array.isArray(record.grantedTools)
    ? record.grantedTools.filter((t): t is string => typeof t === "string")
    : [];
  return { spec, grantedTools };
}

function triggerLine(spec: SpecLike): string {
  const t = spec.trigger;
  if (t.type === "schedule") {
    if (typeof t["at"] === "string") return `Once at ${t["at"]}`;
    return `On schedule ${String(t["cron"])} (${String(t["timezone"] ?? "UTC")})`;
  }
  if (t.type === "host_event") {
    const event = String(t["event"] ?? "");
    if (event === "transaction.created") return "A transaction is created";
    const label = humanize(event.replace(/\./g, " ")).toLowerCase();
    return label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : "Something happens";
  }
  return `When ${humanize(String(t["trigger"]).replace(/\./g, " ")).toLowerCase()}`;
}

/** First sentence of an agent goal, clamped — the full prompt (with its {{ }}
 *  templates) reads as scary machinery and lives in the details disclosure. */
function brief(text: string | undefined, max = 110): string {
  if (!text) return "";
  const sentence = text.split(/(?<=\.)\s/)[0] ?? text;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function flattenSteps(steps: StepLike[] | undefined, depth = 0): Array<{ step: StepLike; depth: number }> {
  const out: Array<{ step: StepLike; depth: number }> = [];
  for (const step of steps ?? []) {
    out.push({ step, depth });
    out.push(...flattenSteps(step.then, depth + 1));
    out.push(...flattenSteps(step.else, depth + 1));
    out.push(...flattenSteps(step.steps, depth + 1));
  }
  return out;
}

function gatedTools(spec: SpecLike): string[] {
  const names = new Set<string>();
  if (spec.execution.mode === "agent") {
    for (const t of spec.execution.tools ?? []) names.add(t);
  } else {
    for (const { step } of flattenSteps(spec.execution.steps)) {
      if (step.type === "tool" && step.tool) names.add(step.tool);
      if (step.type === "agent") for (const t of step.tools ?? []) names.add(t);
    }
  }
  return [...names];
}

function formatHour(hour: string): string {
  const n = Number(hour);
  if (!Number.isFinite(n)) return hour;
  if (n === 0) return "midnight";
  if (n < 12) return `${n}:00 AM`;
  if (n === 12) return "noon";
  return `${n - 12}:00 PM`;
}

function formatCondition(condition: string | undefined): string | undefined {
  if (!condition) return undefined;
  const amount = condition.match(/trigger\.amount\s*>\s*(\d+(?:\.\d+)?)/i)?.[1];
  if (amount) return `For charges over $${Number(amount).toLocaleString("en-US")}`;

  const debit = /trigger\.direction\s*={1,2}\s*['"]?debit['"]?/i.test(condition);
  const beforeHour = condition.match(/trigger\.hour\s*<\s*(\d{1,2})/i)?.[1];
  if (debit && beforeHour) return `For outgoing transactions before ${formatHour(beforeHour)}`;
  if (beforeHour) return `Before ${formatHour(beforeHour)}`;
  if (debit) return "For outgoing transactions";

  return "Only when the saved condition matches";
}

function formatList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  // Callers pass verb-initial action phrases ("Search Gmail", "Send email").
  if (items.length === 2) return `${items[0]} and ${items[1]!.charAt(0).toLowerCase()}${items[1]!.slice(1)}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)!.charAt(0).toLowerCase()}${items.at(-1)!.slice(1)}`;
}

function stepSummary(step: StepLike): string | undefined {
  if (step.type === "tool") {
    const tool = step.tool ?? "";
    const action = toolAction(tool).request;
    const input = step.input ?? {};
    if (/^GMAIL_SEND/i.test(tool) && typeof input.to === "string") return `Send email to ${input.to}`;
    if (/^SLACK_/i.test(tool) && /SEND|POST/i.test(tool) && typeof input.channel === "string") {
      return `Post to ${input.channel}`;
    }
    return action;
  }
  if (step.type === "agent") return brief(step.goal, 90);
  if (step.type === "branch") return "Check a condition";
  if (step.type === "loop") return "Repeat for matching items";
  return undefined;
}

function outcomeLine(spec: SpecLike, steps: Array<{ step: StepLike; depth: number }>): string {
  if (spec.execution.mode === "agent") return brief(spec.execution.goal, 130) || "Let Vendo handle the task";
  const summaries = Array.from(new Set(steps.map(({ step }) => stepSummary(step)).filter((s): s is string => Boolean(s))));
  if (summaries.length > 0) return formatList(summaries.slice(0, 3));
  return brief(spec.description, 130) || "Run the approved steps";
}

const TOOL_BRANDS: Record<string, { id: string; name: string }> = {
  GMAIL: { id: "gmail", name: "Gmail" },
  SLACK: { id: "slack", name: "Slack" },
  NOTION: { id: "notion", name: "Notion" },
  GITHUB: { id: "github", name: "GitHub" },
  GOOGLECALENDAR: { id: "googlecalendar", name: "Google Calendar" },
  LINEAR: { id: "linear", name: "Linear" },
  GOOGLEDRIVE: { id: "googledrive", name: "Google Drive" },
  DISCORD: { id: "discord", name: "Discord" },
  GOOGLESHEETS: { id: "googlesheets", name: "Google Sheets" },
  GOOGLEDOCS: { id: "googledocs", name: "Google Docs" },
  STRIPE: { id: "stripe", name: "Stripe" },
  JIRA: { id: "jira", name: "Jira" },
  ASANA: { id: "asana", name: "Asana" },
  HUBSPOT: { id: "hubspot", name: "HubSpot" },
  AIRTABLE: { id: "airtable", name: "Airtable" },
};

function brandForTool(tool: string): { id: string; name: string } {
  const prefix = tool.split("_")[0]?.toUpperCase() ?? "";
  return TOOL_BRANDS[prefix] ?? { id: prefix.toLowerCase(), name: humanize(prefix) || "Tool" };
}

export interface AutomationAppAccess {
  key: string;
  brandId: string;
  name: string;
  actions: string[];
  canRunAutomatically: boolean;
}

function appAccessGroups(tools: string[], granted: Set<string>): AutomationAppAccess[] {
  const groups = new Map<string, AutomationAppAccess>();
  for (const tool of tools) {
    const brand = brandForTool(tool);
    const group = groups.get(brand.name) ?? {
      key: brand.name,
      brandId: brand.id,
      name: brand.name,
      actions: [],
      canRunAutomatically: true,
    };
    const action = toolAction(tool).request;
    if (!group.actions.includes(action)) group.actions.push(action);
    if (!granted.has(tool)) group.canRunAutomatically = false;
    groups.set(brand.name, group);
  }
  return [...groups.values()];
}

export interface AutomationCardModel {
  name: string;
  title: string;
  trigger: string;
  condition?: string;
  outcome: string;
  access: AutomationAppAccess[];
  detailJson: string;
}

export function automationCardModel(toolName: string, input: unknown): AutomationCardModel | undefined {
  const parsed = parseSpec(input);
  if (!parsed) return undefined;
  const { spec, grantedTools } = parsed;
  const granted = new Set(grantedTools);
  const verb = toolName === "update_automation" ? "Update" : "Turn on";
  const steps = flattenSteps(spec.execution.steps);
  const tools = gatedTools(spec);

  return {
    name: spec.name,
    title: `${verb} "${spec.name}"?`,
    trigger: triggerLine(spec),
    condition: formatCondition(spec.if),
    outcome: outcomeLine(spec, steps),
    access: appAccessGroups(tools, granted),
    detailJson: JSON.stringify({ spec, grantedTools }, null, 2),
  };
}

export interface AutomationCardProps {
  toolName: string;
  input: unknown;
  onApprove: () => void;
  onDecline: () => void;
}

export function AutomationCard({ toolName, input, onApprove, onDecline }: AutomationCardProps) {
  const model = automationCardModel(toolName, input);
  // Unfamiliar shape: fail open to the generic approval card, never hide a call.
  if (!model) {
    return <ApprovalCard toolName={toolName} input={input} onApprove={onApprove} onDecline={onDecline} />;
  }
  const { title, access, trigger, condition, outcome, detailJson } = model;

  return (
    <div className="fl-approval fl-automation-approval" role="group" aria-label={title}>
      <div className="fl-auto-approval-head">
        <div className="fl-auto-approval-heading">
          <div className="fl-approval-eyebrow">Needs your approval</div>
          <div className="fl-auto-approval-title">{title}</div>
        </div>
        {access.length > 0 ? (
          <div className="fl-auto-logo-stack" aria-label={`Uses ${access.map((app) => app.name).join(", ")}`}>
            {access.slice(0, 3).map((app) => (
              <span className="fl-auto-logo" key={app.key} title={app.name}>
                <BrandIcon id={app.brandId} size={17} />
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="fl-auto-summary" aria-label="Automation summary">
        <div className="fl-auto-summary-row">
          <span className="fl-auto-summary-k">When</span>
          <div className="fl-auto-summary-v">
            <strong>{trigger}</strong>
            {condition ? <span>{condition}</span> : null}
          </div>
        </div>
        <div className="fl-auto-summary-row">
          <span className="fl-auto-summary-k">Then</span>
          <div className="fl-auto-summary-v">
            <strong>{outcome}</strong>
          </div>
        </div>
      </div>

      {access.length > 0 ? (
        <div className="fl-auto-access">
          <div className="fl-auto-access-label">Permissions</div>
          {access.map((app) => (
            <div className="fl-auto-access-row" key={app.key}>
              <span className="fl-auto-access-logo" aria-hidden="true">
                <BrandIcon id={app.brandId} size={17} />
              </span>
              <div className="fl-auto-access-copy">
                <div className="fl-auto-access-title">{app.name}</div>
                <div className="fl-auto-access-sub">{formatList(app.actions)}</div>
              </div>
              <span className="fl-auto-access-badge" data-auto={app.canRunAutomatically || undefined}>
                {app.canRunAutomatically ? "Runs on its own" : "Asks you each time"}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <details className="fl-auto-details">
        <summary>View setup details</summary>
        {/* grantedTools included: friendly labels above can collapse two tool
            slugs onto one name, so the consent trail needs the raw grants. */}
        <pre>
          {detailJson}
        </pre>
      </details>

      <div className="fl-approval-actions">
        <button type="button" className="fl-btn fl-btn-primary" onClick={onApprove}>
          Turn on automation
        </button>
        <button type="button" className="fl-btn" onClick={onDecline}>
          Not now
        </button>
      </div>
    </div>
  );
}
