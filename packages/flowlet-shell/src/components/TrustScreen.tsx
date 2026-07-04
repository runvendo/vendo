/**
 * TrustScreen (spec §3 Moment 12) — behind a quiet shield icon. Five
 * sections: what's handled without asking, what automations run
 * unattended (read-only, federated), what always needs the human
 * (critical tools, can't be changed), what's waiting, and the weekly
 * plain-English activity/diary. Seams: `useTrustData` (mirrors
 * `useParkedActions` exactly).
 */
import { useTrustData } from "../use-trust-data";
import { toolAction } from "./tool-labels";
import { WaitingList } from "./WaitingList";
import { relativeTimeLabel } from "../relative-time";
import type { TrustAuditRow } from "../context";

export interface TrustScreenProps {
  onClose: () => void;
}

function auditLine(row: TrustAuditRow): string {
  switch (row.kind) {
    case "tool_execution":
      return row.dangerous ? `${toolAction(row.toolName ?? "").done} — a money move` : toolAction(row.toolName ?? "").done;
    case "automation_firing":
      return "An automation ran";
    case "grant_created":
      return "Started handling something without asking";
    case "grant_revoked":
      return "Asked to check again on something";
    case "judge_escalation":
      return "Stopped to check something unusual";
    case "consent":
      return "Answered a request";
    default:
      return "Activity";
  }
}

export function TrustScreen({ onClose }: TrustScreenProps) {
  const { grants, automationGrants, criticalTools, activity, diary, parked, revoke } = useTrustData();

  return (
    <div className="fl-trust" role="dialog" aria-modal="true" aria-label="Trust">
      <div className="fl-trust-head">
        <div className="fl-trust-title">Vendo acts with your account. Here&apos;s where you stand.</div>
        <button type="button" className="fl-trust-close" aria-label="Close" onClick={onClose}>×</button>
      </div>

      <section className="fl-trust-section">
        <h3 className="fl-trust-section-head">Handled without asking</h3>
        {grants.length === 0 && <div className="fl-trust-empty">Nothing yet — everything still asks.</div>}
        {grants.map((g) => (
          <div key={g.id} className="fl-trust-row">
            <div className="fl-trust-row-main">
              <div className="fl-trust-row-title">{toolAction(g.tool).request} · {g.scopePreview}</div>
              <div className="fl-trust-row-meta">since {relativeTimeLabel(Date.parse(g.since))}</div>
            </div>
            {g.id && (
              <button type="button" className="fl-btn" onClick={() => revoke(g.id!)}>Ask me again</button>
            )}
          </div>
        ))}
      </section>

      <section className="fl-trust-section">
        <h3 className="fl-trust-section-head">Automations</h3>
        {automationGrants.length === 0 && <div className="fl-trust-empty">No automations running unattended yet.</div>}
        {automationGrants.map((g, i) => (
          <div key={`${g.automationName}-${g.tool}-${i}`} className="fl-trust-row">
            <div className="fl-trust-row-main">
              <div className="fl-trust-row-title">{g.automationName} — {toolAction(g.tool).request}</div>
              <div className="fl-trust-row-meta">runs as agreed</div>
            </div>
          </div>
        ))}
      </section>

      <section className="fl-trust-section">
        <h3 className="fl-trust-section-head">Always needs you</h3>
        <div className="fl-trust-critical">
          {criticalTools.length === 0
            ? "Nothing critical registered."
            : criticalTools.map((t) => toolAction(t.name).request).join(" · ")}
        </div>
      </section>

      {parked.count > 0 && (
        <section className="fl-trust-section">
          <h3 className="fl-trust-section-head">Waiting on you ({parked.count})</h3>
          <WaitingList actions={parked.actions} onApprove={parked.approve} onDecline={parked.decline} />
        </section>
      )}

      <section className="fl-trust-section">
        <h3 className="fl-trust-section-head">Activity — {diary.total} actions this week</h3>
        <div className="fl-trust-diary">
          This week I handled {diary.total} thing{diary.total === 1 ? "" : "s"} — {diary.reads} reads,{" "}
          {diary.approved} action{diary.approved === 1 ? "" : "s"} you approved, {diary.automationRuns} ran in
          automations. Money moves: {diary.moneyMoves}.
        </div>
        <div className="fl-trust-activity">
          {activity.slice(0, 20).map((row, i) => (
            <div key={i} className="fl-trust-activity-row">
              <span className="fl-trust-activity-time">{relativeTimeLabel(Date.parse(row.at))}</span>
              <span>{auditLine(row)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
