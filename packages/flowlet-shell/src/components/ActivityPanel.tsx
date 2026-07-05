import { useState } from "react";
import type { ToolItem } from "../use-flowlet-thread";
import { toolAction } from "./tool-labels";
import { ActivityStep } from "./ActivityStep";
import { isPolicyDenied } from "./tool-output";

export interface ActivityPanelProps {
  steps: ToolItem[];
  /** True while this turn is still running — drives the live header. */
  working?: boolean;
}

const isTerminal = (state: string) =>
  state === "output-available" || state === "output-error" || state === "output-denied";

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
  // While the turn runs, lead with the live (non-terminal) step. With every
  // step settled, fall back to the last SUCCESSFUL one — echoing a denied or
  // failed step as "Working (…)" would misread as the tool still executing.
  const active = working
    ? [...steps].reverse().find((s) => !isTerminal(s.state)) ??
      (last.state === "output-available" && !isPolicyDenied(last.output) ? last : undefined)
    : undefined;
  const hasError = steps.some((s) => s.state === "output-error");
  const hasDenied = steps.some((s) => s.state === "output-denied");
  // A policy-denied SERVER call settles at `output-available` (finding 1 —
  // see ActivityStep for the full explanation), so it must be excluded from
  // `hasSuccess` and folded into the same "not actually a success" bucket as
  // `hasDenied` here, or the header would still show a ✓ + the done label.
  const hasBlocked = steps.some((s) => s.state === "output-available" && isPolicyDenied(s.output));
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
    // Error wins over denied/blocked; neither must ever read as a success
    // tick. A mixed turn (some steps ran, one was declined/blocked) is
    // "Partly done" — plain "Declined"/"Blocked" would erase the work that
    // DID happen.
    const hasSuccess = steps.some((s) => s.state === "output-available" && !isPolicyDenied(s.output));
    const icon = hasError ? "✕" : hasDenied || hasBlocked ? "⊘" : "✓";
    const label = hasError
      ? "Ran into an issue"
      : hasDenied || hasBlocked
        ? hasSuccess
          ? "Partly done"
          : hasDenied
            ? "Declined"
            : "Blocked by your settings"
        : toolAction(last.toolName).done;
    header = (
      <>
        <span className={`fl-act-ic ${hasError ? "fl-act-head-err" : ""}`} aria-hidden="true">
          {icon}
        </span>
        <span className="fl-act-head-lbl">{label}</span>
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
