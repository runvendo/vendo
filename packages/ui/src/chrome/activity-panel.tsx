import { useState } from "react";
import { useActivity } from "../hooks/use-activity.js";
import { useVendoTools } from "../context.js";
import { ChromeRoot } from "./chrome-root.js";
import {
  describeActivity,
  formatAuditTime,
  outcomeLabel,
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

/** 08-ui §4 — self-scoped, user-facing audit transparency. Every row is a
    concrete action taken as the user (a tool call, an approval, a connection…)
    with a humanized label, a human timestamp and a plain-language result;
    pagination ends in an explicit end-of-list marker. */
export function ActivityPanel() {
  const { events, isLoading, hasMore, loadMore } = useActivity();
  const tools = useVendoTools();
  const [error, setError] = useState<string>();

  const loadNext = async () => {
    setError(undefined);
    try {
      await loadMore();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <ChromeRoot>
      <section className="fl-act" aria-labelledby="vendo-activity-heading">
        <header className="fl-act-head">
          <span className="fl-act-ic fl-act-tick" aria-hidden="true">✓</span>
          <h2 id="vendo-activity-heading" className="fl-act-head-lbl" style={{ margin: 0 }}>Activity</h2>
        </header>
        {error ? <div role="alert" className="fl-act-err fl-act-row">{error}</div> : null}
        {events.length === 0 ? (
          <p className="fl-act-row fl-act-now">
            {isLoading ? "Loading activity…" : "Nothing has run as you yet"}
          </p>
        ) : (
          <table className="fl-act-table">
            <caption className="fl-act-cap">Actions performed as your account</caption>
            <thead className="fl-act-thead">
              <tr className="fl-act-grid">
                <th className="fl-act-th">Activity</th>
                <th className="fl-act-th">Details</th>
                <th className="fl-act-th">Result</th>
                <th className="fl-act-th">When</th>
              </tr>
            </thead>
            <tbody className="fl-act-tbody">
              {events.map(event => {
                const { kindLabel, action } = describeActivity(event, tools);
                const { label, tone } = outcomeLabel(event.outcome);
                return (
                  <tr className="fl-act-grid" key={event.id}>
                    <td className="fl-act-cell">
                      <span className="fl-act-kind">{kindLabel}</span>
                      <span className="fl-act-action">{action}</span>
                    </td>
                    <td className="fl-act-cell fl-act-detail">{event.inputPreview ?? "—"}</td>
                    <td className="fl-act-cell">
                      <span className="fl-act-outcome">
                        <OutcomeIcon tone={tone} />
                        <span>{label}</span>
                      </span>
                      {event.decidedBy ? <div className="fl-act-by">by {event.decidedBy}</div> : null}
                    </td>
                    <td className="fl-act-cell fl-act-when">
                      <time dateTime={event.at} title={event.at}>{formatAuditTime(event.at)}</time>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {events.length > 0 ? (
          <div className="fl-act-foot">
            {hasMore ? (
              <button className="fl-btn" type="button" onClick={() => void loadNext()}>Load more</button>
            ) : (
              <p className="fl-act-end" data-testid="activity-end">You’ve reached the end of your activity.</p>
            )}
          </div>
        ) : null}
      </section>
    </ChromeRoot>
  );
}
