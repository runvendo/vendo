/**
 * The automation card (spec section d, content outline approved; visual
 * treatment reuses the approval-card patterns — Yousef-gated).
 *
 * Proposal state: the create/update approval. The user reads exactly what the
 * automation will do — trigger + guard, each step's tool and concrete input
 * mapping, which gated tools run unattended (grants) vs pause each firing —
 * then approves or declines the whole package. The raw spec is one disclosure
 * away (the inspectability escape hatch).
 *
 * The shell deliberately does not import the automations engine: the card
 * parses the tool-call input defensively and falls back to the generic
 * approval JSON dump when the shape is unfamiliar.
 */
import type { CSSProperties } from "react";
import { ApprovalCard } from "./ApprovalCard";
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

function tierOf(spec: SpecLike): string {
  if (spec.execution.mode === "agent") return "agentic";
  let hybrid = false;
  const walk = (steps: StepLike[] | undefined): void => {
    for (const s of steps ?? []) {
      if (s.type === "agent") hybrid = true;
      walk(s.then);
      walk(s.else);
      walk(s.steps);
    }
  };
  walk(spec.execution.steps);
  return hybrid ? "hybrid" : "deterministic";
}

function triggerLine(spec: SpecLike): string {
  const t = spec.trigger;
  if (t.type === "schedule") {
    if (typeof t["at"] === "string") return `Once at ${t["at"]}`;
    return `On schedule ${String(t["cron"])} (${String(t["timezone"] ?? "UTC")})`;
  }
  // Friendly event names: `transaction.created` -> "When transaction created".
  if (t.type === "host_event") return `When ${humanize(String(t["event"]).replace(/\./g, " ")).toLowerCase()}`;
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

export interface AutomationCardProps {
  toolName: string;
  input: unknown;
  onApprove: () => void;
  onDecline: () => void;
}

export function AutomationCard({ toolName, input, onApprove, onDecline }: AutomationCardProps) {
  const parsed = parseSpec(input);
  // Unfamiliar shape: fail open to the generic approval card, never hide a call.
  if (!parsed) {
    return <ApprovalCard toolName={toolName} input={input} onApprove={onApprove} onDecline={onDecline} />;
  }
  const { spec, grantedTools } = parsed;
  const granted = new Set(grantedTools);
  const tier = tierOf(spec);
  const verb = toolName === "update_automation" ? "Update automation" : "New automation";
  const steps = flattenSteps(spec.execution.steps);
  const tools = gatedTools(spec);

  const mono: CSSProperties = { fontFamily: "var(--flowlet-font-mono)", fontSize: 11 };
  const muted: CSSProperties = { color: "var(--flowlet-fg-muted)" };

  return (
    <div className="fl-approval" role="group" aria-label={`${verb}: ${spec.name}`}>
      <div className="fl-approval-eyebrow">{verb} · approval required</div>

      <div style={{ marginTop: 8, display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 650 }}>{spec.name}</span>
        <span className="fl-chip" style={{ fontSize: 11, textTransform: "capitalize" }}>{tier}</span>
      </div>

      {spec.description ? (
        <div style={{ fontSize: 12, marginTop: 4 }}>{spec.description}</div>
      ) : null}
      {spec.prompt ? (
        <div style={{ fontSize: 11, marginTop: 4, ...muted }}>You asked: “{spec.prompt}”</div>
      ) : null}

      <div style={{ fontSize: 12, marginTop: 10 }}>
        <span style={muted}>Trigger · </span>
        {triggerLine(spec)}
        {spec.if ? (
          <div style={{ ...mono, marginTop: 2, ...muted }}>only if {spec.if}</div>
        ) : null}
      </div>

      <div style={{ fontSize: 12, marginTop: 10 }}>
        <span style={muted}>Steps</span>
        <ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {spec.execution.mode === "agent" ? (
            <li>AI step — {brief(spec.execution.goal)}</li>
          ) : (
            steps.map(({ step, depth }) => (
              <li key={step.id} style={{ marginLeft: depth * 14, marginTop: 2 }}>
                {step.type === "tool" ? (
                  toolAction(step.tool ?? "").request
                ) : step.type === "agent" ? (
                  <>AI step — {brief(step.goal)}</>
                ) : step.type === "branch" ? (
                  <>
                    If <span style={{ ...mono, ...muted }}>{step.if}</span>
                  </>
                ) : (
                  <>
                    For each <span style={{ ...mono, ...muted }}>{step.items}</span>
                  </>
                )}
                {step.type !== "branch" && step.if ? (
                  <div style={{ ...mono, ...muted }}>only if {step.if}</div>
                ) : null}
              </li>
            ))
          )}
        </ol>
      </div>

      {tools.length > 0 ? (
        <div style={{ fontSize: 12, marginTop: 10 }}>
          <span style={muted}>It can</span>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {tools.map((tool) => (
              <li key={tool} style={{ marginTop: 2 }}>
                {toolAction(tool).request}{" "}
                <span style={muted}>
                  {granted.has(tool) ? "— runs without asking" : "— asks you each time"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <details style={{ marginTop: 10 }}>
        <summary style={{ fontSize: 11, cursor: "pointer", ...muted }}>Show technical details</summary>
        <pre style={{ fontSize: 11, margin: "6px 0 0", whiteSpace: "pre-wrap", ...mono }}>
          {JSON.stringify(spec, null, 2)}
        </pre>
      </details>

      <div className="fl-approval-actions">
        <button type="button" className="fl-btn fl-btn-primary" onClick={onApprove}>
          Approve automation
        </button>
        <button type="button" className="fl-btn" onClick={onDecline}>
          Decline
        </button>
      </div>
    </div>
  );
}
