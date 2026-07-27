"use client";

import { describeModel } from "../runner/models";
import type { LaneResult, RunRecord } from "../runner/types";
import { formatDuration } from "./lane-meta";

/** History rail: pinned runs first (they are the compare baselines), then
 *  newest-first. Click loads a run read-only; ⌥-click split-compares it
 *  against the current one; the ★ toggle pins/unpins. */
export function HistoryRail({
  runs,
  selectedId,
  compareId,
  onSelect,
  onTogglePin,
}: {
  runs: RunRecord[];
  selectedId: string | null;
  compareId: string | null;
  onSelect: (id: string, altKey: boolean) => void;
  onTogglePin: (run: RunRecord) => void;
}) {
  const ordered = sortPinnedFirst(runs);
  return (
    <div className="rail">
      <h3>Runs</h3>
      {ordered.length === 0 && <div className="rail-empty">no runs yet — hit Run, or use the CLI</div>}
      {ordered.map((run) => (
        <div
          key={run.id}
          className={`run-item${run.id === selectedId ? " sel" : ""}${run.id === compareId ? " cmp" : ""}`}
          onClick={(event) => onSelect(run.id, event.altKey)}
        >
          <div className="rprompt">
            {run.pin && <span className="pinbadge">★ {run.pin} </span>}
            {run.request.prompt}
          </div>
          {/* The model rides the rail, not the pane header: split-compare is
              now also a model A/B, and both arms are picked from here. */}
          <div className="rmeta">
            {timeOf(run)} · {run.gitSha.slice(0, 7)}
            {run.gitDirty ? "+" : ""} · {railDuration(run)} · {describeModel(run.request.model)}
          </div>
          <button
            type="button"
            className={`pinbtn${run.pin ? " pinned" : ""}`}
            aria-label={run.pin ? `Unpin ${run.id}` : `Pin ${run.id}`}
            title={run.pin ? `unpin (${run.pin})` : "pin"}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin(run);
            }}
          >
            {run.pin ? "★" : "☆"}
          </button>
        </div>
      ))}
      <div className="compare-note">
        ⌥-click any run to <b>split-compare</b> it against the current one.
      </div>
    </div>
  );
}

/** Pins sort first (rail doubles as the compare picker); both groups stay
 *  newest-first within themselves (/api/runs order). */
function sortPinnedFirst(runs: RunRecord[]): RunRecord[] {
  const pinned = runs.filter((run) => run.pin);
  const rest = runs.filter((run) => !run.pin);
  return [...pinned, ...rest];
}

function timeOf(run: RunRecord): string {
  const date = new Date(run.createdAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Wall clock of the slowest lane — what the run "took". */
function railDuration(run: RunRecord): string {
  let max = 0;
  for (const result of Object.values(run.lanes) as LaneResult[]) {
    if (result.status !== "no-key") max = Math.max(max, result.durationMs);
  }
  return formatDuration(max);
}
