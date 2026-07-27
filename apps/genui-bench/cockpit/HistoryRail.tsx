"use client";

import type { LaneResult, RunRecord } from "../runner/types";
import { formatDuration } from "./lane-meta";

/** History rail: runs newest-first (slim records from /api/runs), pinned runs
 *  marked with ★; click loads a run read-only. */
export function HistoryRail({
  runs,
  selectedId,
  onSelect,
}: {
  runs: RunRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="rail">
      <h3>Runs</h3>
      {runs.length === 0 && <div className="rail-empty">no runs yet — hit Run, or use the CLI</div>}
      {runs.map((run) => (
        <div
          key={run.id}
          className={`run-item${run.id === selectedId ? " sel" : ""}`}
          onClick={() => onSelect(run.id)}
        >
          <div className="rprompt">
            {run.pin && <span className="pinbadge">★ {run.pin} </span>}
            {run.request.prompt}
          </div>
          <div className="rmeta">
            {timeOf(run)} · {run.gitSha.slice(0, 7)}
            {run.gitDirty ? "+" : ""} · {railDuration(run)}
          </div>
        </div>
      ))}
      <div className="compare-note">
        ⌥-click any run to <b>split-compare</b> it against the current one.
      </div>
    </div>
  );
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
