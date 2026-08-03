"use client";

import type { HostName, LaneName, LaneResult, RunRecord } from "../runner/types";
import type { PaneComponent } from "./pane-props";
import { LANE_FOOTNOTES, LANE_LABELS, findingCount, formatDuration } from "./lane-meta";

/** The four-pane grid. Deliberately generic: page.tsx passes the
 *  LaneName → PaneComponent mapping, so real panes (VendoPane, competitor
 *  SDK panes) swap in without touching the grid. */
export function PaneGrid({
  panes,
  lanes,
  record,
  compare,
  running,
  host,
}: {
  panes: Record<LaneName, PaneComponent>;
  lanes: LaneName[];
  record: RunRecord | null;
  /** Split-compare: a second run whose lane results render beside the first. */
  compare?: RunRecord | null;
  running: boolean;
  host: HostName;
}) {
  return (
    <div
      className="panes"
      style={{ gridTemplateColumns: `repeat(${Math.max(lanes.length, 1)}, minmax(0, 1fr))` }}
    >
      {lanes.map((lane) => {
        const Pane = panes[lane];
        const result = record?.lanes[lane];
        const compareResult = compare?.lanes[lane];
        return (
          <section key={lane} className="pane" aria-label={LANE_LABELS[lane]}>
            <div className="pane-h">
              <span className={`status ${statusClass(result, running)}`} />
              <span className="name">{LANE_LABELS[lane]}</span>
              <span className="time">{headerTime(result, running)}</span>
            </div>
            <div className="pane-body">
              {record && result ? (
                <Pane
                  lane={lane}
                  result={result}
                  runId={record.id}
                  host={host}
                  {...(compare && compareResult ? { compare: { result: compareResult, runId: compare.id } } : {})}
                />
              ) : running ? (
                <>
                  <div className="skel" style={{ width: "85%" }} />
                  <div className="skel" style={{ width: "60%" }} />
                  <div className="skel" style={{ width: "75%" }} />
                  <div className="skel" style={{ width: "40%" }} />
                </>
              ) : (
                <div className="pane-empty">no run loaded</div>
              )}
            </div>
            <div className="pane-note">{running && !result ? "generating…" : LANE_FOOTNOTES[lane]}</div>
          </section>
        );
      })}
    </div>
  );
}

function statusClass(result: LaneResult | undefined, running: boolean): string {
  if (!result) return running ? "run" : "idle";
  if (result.status === "no-key") return "idle";
  if (result.status === "failed") return "err";
  return findingCount(result) > 0 ? "warn" : "ok";
}

function headerTime(result: LaneResult | undefined, running: boolean): string {
  if (!result) return running ? "…" : "";
  if (result.status === "no-key") return "no key";
  const findings = findingCount(result);
  const time = formatDuration(result.durationMs);
  return findings > 0 ? `${time} · ${findings} finding${findings === 1 ? "" : "s"}` : time;
}
