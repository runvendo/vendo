import { useState } from "react";
import type { ToolItem } from "../use-flowlet-thread";
import { toolAction } from "./tool-labels";
import { ActivityStep } from "./ActivityStep";

export interface ActivityPanelProps {
  steps: ToolItem[];
  /** True while this turn is still running — drives the live header. */
  working?: boolean;
}

const isTerminal = (state: string) => state === "output-available" || state === "output-error";

/**
 * One collapsible panel per turn that narrates its tool calls. Collapsed by
 * default: while working the header shows the live step in parentheses; once
 * settled it leads with the last action (`✓ Posted to Slack · +2 more`).
 * Expanding reveals the ordered step list with result peeks.
 */
export function ActivityPanel({ steps, working = false }: ActivityPanelProps) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;

  const last = steps[steps.length - 1]!;
  const active = working
    ? [...steps].reverse().find((s) => !isTerminal(s.state)) ?? last
    : undefined;
  const hasError = steps.some((s) => s.state === "output-error");
  const more = steps.length - 1;

  let header: React.ReactNode;
  if (active) {
    header = (
      <>
        <span className="fl-act-pulse" aria-hidden="true" />
        <span className="fl-act-head-lbl">Working</span>
        <span className="fl-act-now">({toolAction(active.toolName).active}…)</span>
      </>
    );
  } else {
    header = (
      <>
        <span className={`fl-act-ic ${hasError ? "fl-act-head-err" : ""}`} aria-hidden="true">
          {hasError ? "✕" : "✓"}
        </span>
        <span className="fl-act-head-lbl">
          {hasError ? "Ran into an issue" : toolAction(last.toolName).done}
        </span>
        {more > 0 && <span className="fl-act-now">· +{more} more</span>}
      </>
    );
  }

  return (
    <div className="fl-act" data-testid="activity-panel" data-open={open}>
      <button
        type="button"
        className="fl-act-head"
        aria-expanded={open}
        aria-label={open ? "Hide activity" : "Show activity"}
        onClick={() => setOpen((v) => !v)}
      >
        {header}
        <span className={`fl-act-chev ${open ? "fl-act-chev-open" : ""}`} aria-hidden="true">›</span>
      </button>
      {open && (
        <div className="fl-act-body">
          {steps.map((step) => (
            <ActivityStep key={step.key} step={step} showPeek />
          ))}
        </div>
      )}
    </div>
  );
}
