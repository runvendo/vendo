/** ui-lane-panels pick B — the icon-ledger activity rows, shared by
    ActivityPanel (full audit) and VendoActivities (shelf feed) so the two
    surfaces can't drift. One scannable line per action: kind glyph disc,
    humanized action with the input preview folded in, outcome with decider,
    relative timestamp (absolute in the title/dateTime). */
import type { AuditEvent } from "@vendoai/core";
import { useEffect, useState } from "react";
import type { ToolMetaMap } from "./humanize.js";
import {
  describeActivity,
  formatAuditTime,
  formatRelativeAuditTime,
  kindGlyph,
  outcomeLabel,
  type ActivityGlyph,
  type OutcomeTone,
} from "./activity-semantics.js";

/** The status glyph for an outcome tone. In-flight tones animate (pulse/spin);
    settled tones use a static tick / cross that reads without colour alone. */
function OutcomeIcon({ tone }: { tone: OutcomeTone }) {
  if (tone === "running") return <span className="fl-act-pulse" aria-hidden="true" />;
  if (tone === "pending") return <span className="fl-act-spin" aria-hidden="true" />;
  const glyph = tone === "ok" ? "✓" : tone === "connect" ? "⭘" : "✕";
  const cls = tone === "ok" ? "fl-act-tick" : tone === "connect" ? "fl-act-denied" : "fl-act-x";
  return <span className={`fl-act-ic ${cls}`} aria-hidden="true">{glyph}</span>;
}

const GLYPH_PATHS: Record<ActivityGlyph, string> = {
  wrench:
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
  zap: "m13 2-9 12h8l-1 8 9-12h-8l1-8Z",
  shield:
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
  box: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z M3.3 7l8.7 5 8.7-5 M12 22V12",
};

function KindGlyph({ kind, label }: { kind: AuditEvent["kind"]; label: string }) {
  return (
    <span className="fl-act-led-ic" role="img" aria-label={label} title={label}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {GLYPH_PATHS[kindGlyph(kind)].split(" M").map((d, i) => (
          <path key={i} d={i === 0 ? d : `M${d}`} />
        ))}
      </svg>
    </span>
  );
}

/** The rows only — header, caption, footer and empty states stay with the
    owning panel (they differ between the audit table and the shelf feed). */
export function ActivityLedger({ events, tools }: { events: AuditEvent[]; tools?: ToolMetaMap }) {
  // Relative labels ride a slow clock so "just now" doesn't freeze forever in
  // a non-polling panel; minute precision needs nothing faster.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <ul className="fl-act-led" role="list">
      {events.map(event => {
        const { kindLabel, action } = describeActivity(event, tools);
        const { label, tone } = outcomeLabel(event.outcome);
        return (
          <li className="fl-act-led-row" key={event.id}>
            <KindGlyph kind={event.kind} label={kindLabel} />
            <span className="fl-act-led-main">
              <b>{action}</b>
              {event.inputPreview ? <span className="fl-act-led-det"> — {event.inputPreview}</span> : null}
            </span>
            <span className="fl-act-led-out">
              <span className="fl-act-outcome">
                <OutcomeIcon tone={tone} />
                <span>
                  {label}
                  {event.decidedBy ? <span className="fl-act-led-by"> by {event.decidedBy}</span> : null}
                </span>
              </span>
            </span>
            <time className="fl-act-when" dateTime={event.at} title={formatAuditTime(event.at)}>
              {formatRelativeAuditTime(event.at, now)}
            </time>
          </li>
        );
      })}
    </ul>
  );
}
