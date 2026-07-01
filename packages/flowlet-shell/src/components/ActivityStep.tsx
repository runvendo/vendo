import type { ToolItem } from "../use-flowlet-thread";
import { toolAction } from "./tool-labels";
import { peekRows, stepSummary } from "./tool-output";

export interface ActivityStepProps {
  step: ToolItem;
  /** When true, render the result peek beneath the row (panel expanded). */
  showPeek?: boolean;
}

/**
 * One tool call inside the activity panel: a status row (working spinner -> done
 * tick -> error cross) and, when expanded, a compact peek of its result.
 */
export function ActivityStep({ step, showPeek = false }: ActivityStepProps) {
  const label = toolAction(step.toolName);
  const done = step.state === "output-available";
  const errored = step.state === "output-error";
  const rows = showPeek && done ? peekRows(step.output) : [];

  return (
    <div className="fl-act-step" data-testid="activity-step" data-state={step.state}>
      <div className="fl-act-row">
        <span className="fl-act-ic" aria-hidden="true">
          {errored ? <span className="fl-act-x">✕</span>
            : done ? <span className="fl-act-tick">✓</span>
            : <span className="fl-act-spin" />}
        </span>
        <span className="fl-act-lbl">{errored ? `${label.done} failed` : done ? label.done : label.active}</span>
        {errored && step.errorText ? (
          <span className="fl-act-sub fl-act-err">{step.errorText}</span>
        ) : (
          done && <span className="fl-act-sub">{stepSummary(step.output)}</span>
        )}
      </div>
      {rows.length > 0 && (
        <div className="fl-act-peek">
          {rows.map((r, i) => (
            <div key={i} className="fl-act-peek-row">
              <span className="fl-act-peek-k">{r.label}</span>
              <span className="fl-act-peek-v">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
