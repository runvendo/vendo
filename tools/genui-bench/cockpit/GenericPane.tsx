"use client";

import type { LaneResult } from "../runner/types";
import type { PaneProps } from "./pane-props";
import { formatDuration } from "./lane-meta";

/** Built-in pane: renders any LaneResult as status/timings plus collapsible
 *  raw/document JSON. Every lane maps here until its real pane (VendoPane,
 *  competitor SDK panes) is swapped in via the page-level pane mapping. */
export function GenericPane({ result, compare }: PaneProps) {
  if (!compare) return <ResultView result={result} />;
  return (
    <>
      <div className="gp-half">
        <div className="gp-half-label">current</div>
        <ResultView result={result} />
      </div>
      <div className="gp-half">
        <div className="gp-half-label cmp">compare</div>
        <ResultView result={compare.result} />
      </div>
    </>
  );
}

function ResultView({ result }: { result: LaneResult }) {
  if (result.status === "no-key") {
    return <div className="pane-empty">no key for this lane — set its key in the root .env</div>;
  }
  return (
    <div>
      {result.status === "failed" && <div className="gp-error">{result.error}</div>}
      <div className="gp-stat">
        <span>status</span>
        <b>{result.status}</b>
      </div>
      <div className="gp-stat">
        <span>duration</span>
        <b>{formatDuration(result.durationMs)}</b>
      </div>
      {result.status === "ok" && result.costUsd !== undefined && (
        <div className="gp-stat">
          <span>cost</span>
          <b>${result.costUsd.toFixed(2)}</b>
        </div>
      )}
      {result.status === "ok" && result.findings && (
        <div className="gp-stat">
          <span>findings</span>
          <b>{result.findings.length}</b>
        </div>
      )}
      {"document" in result && result.document !== undefined && (
        <JsonSection label="document JSON" value={result.document} />
      )}
      {result.raw !== undefined && <JsonSection label="raw response" value={result.raw} />}
      {result.wire !== undefined && <TextSection label="wire text" text={result.wire} />}
    </div>
  );
}

function JsonSection({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="gp-json">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function TextSection({ label, text }: { label: string; text: string }) {
  return (
    <details className="gp-json">
      <summary>{label}</summary>
      <pre>{text}</pre>
    </details>
  );
}
