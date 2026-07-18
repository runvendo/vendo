import { useId } from "react";
import { useActivity } from "../hooks/use-activity.js";
import { useApprovals } from "../hooks/use-approvals.js";
import { useVendoTools } from "../context.js";
import {
  describeActivity,
  formatAuditTime,
  outcomeLabel,
  type OutcomeTone,
} from "./activity-semantics.js";
import { ApprovalCard } from "./approval-card.js";
import { ChromeRoot } from "./chrome-root.js";

/** The status glyph for an outcome tone — same treatment as the Activity panel
    (in-flight tones animate; settled tones read without colour alone). */
function OutcomeIcon({ tone }: { tone: OutcomeTone }) {
  if (tone === "running") return <span className="fl-act-pulse" aria-hidden="true" />;
  if (tone === "pending") return <span className="fl-act-spin" aria-hidden="true" />;
  const glyph = tone === "ok" ? "✓" : tone === "connect" ? "⭘" : "✕";
  const cls = tone === "ok" ? "fl-act-tick" : tone === "connect" ? "fl-act-denied" : "fl-act-x";
  return <span className={`fl-act-ic ${cls}`} aria-hidden="true">{glyph}</span>;
}

export interface VendoActivitiesProps {
  /**
   * Poll interval (ms) shared by the approvals queue and the activity feed, so
   * an approval raised elsewhere (a thread turn, the MCP door, an automation)
   * appears here on its own — no page remount. Default 5000; `0` disables
   * polling (initial fetch only).
   */
  pollMs?: number;
  /** Cap on recent-activity rows shown (this piece is a feed, not the full
   *  paginated audit — that stays `ActivityPanel`). Default 8. */
  maxItems?: number;
}

/**
 * The shelf's drop-in feed of what the agent did + what it is waiting on
 * (ui-usage-dx §2) — placeable in any host page. Pending approvals render on
 * top as actionable cards; recent activity renders humanized below. When
 * nothing has happened yet it shows a quiet one-line empty state rather than
 * rendering nothing — hosts place this in their own pages, and an invisible
 * component would read as broken.
 */
export function VendoActivities({ pollMs = 5000, maxItems = 8 }: VendoActivitiesProps = {}) {
  const poll = pollMs > 0 ? { pollMs } : undefined;
  const { pending, decide } = useApprovals(poll);
  const { events, isLoading } = useActivity(poll);
  const tools = useVendoTools();
  const headingId = useId();
  const recent = events.slice(0, Math.max(0, maxItems));

  return (
    <ChromeRoot>
      <section aria-label="Vendo activity" style={{ display: "grid", gap: "14px" }}>
        {pending.length > 0 ? (
          <section aria-labelledby={`${headingId}-approvals`} style={{ display: "grid", gap: "10px" }}>
            <header>
              <h2 id={`${headingId}-approvals`} className="fl-act-head-lbl" style={{ margin: 0, fontSize: "14px" }}>
                Needs your approval
              </h2>
              <p className="fl-act-now" style={{ margin: "3px 0 0", fontSize: "12.5px" }}>
                An agent asked to act on your account. Review the exact request before it runs.
              </p>
            </header>
            {pending.map(approval => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onDecide={decision => decide(approval.id, decision)}
              />
            ))}
          </section>
        ) : null}
        <section className="fl-act" aria-labelledby={`${headingId}-recent`}>
          <header className="fl-act-head" style={{ cursor: "default" }}>
            <span className="fl-act-ic fl-act-tick" aria-hidden="true">✓</span>
            <h2 id={`${headingId}-recent`} className="fl-act-head-lbl" style={{ margin: 0 }}>Recent activity</h2>
          </header>
          {recent.length === 0 ? (
            <p className="fl-act-row fl-act-now">
              {isLoading ? "Loading activity…" : "No recent agent activity yet."}
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
                {recent.map(event => {
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
        </section>
      </section>
    </ChromeRoot>
  );
}
