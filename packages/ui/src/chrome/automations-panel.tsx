import type { ApprovalRequest, AppId, ApprovalDecision } from "@vendoai/core";
import { useState } from "react";
import { useApprovals } from "../hooks/use-approvals.js";
import { useAutomations } from "../hooks/use-automations.js";
import type { RunPlan, RunRecord } from "../wire-types.js";
import { ApprovalCard } from "./approval-card.js";
import { ChromeRoot } from "./chrome-root.js";

/** 08-ui §4; 07-automations §5 — controls, grant capture, previews, history, kill switch. */
export function AutomationsPanel() {
  const automations = useAutomations();
  const approvals = useApprovals();
  const [missing, setMissing] = useState<Record<AppId, ApprovalRequest[]>>({});
  const [plans, setPlans] = useState<Record<AppId, RunPlan | undefined>>({});
  const [runs, setRuns] = useState<Record<AppId, RunRecord[] | undefined>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string>();

  const during = async (key: string, action: () => Promise<void>) => {
    setError(undefined);
    setBusy(current => ({ ...current, [key]: true }));
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(current => ({ ...current, [key]: false }));
    }
  };

  const decide = async (appId: AppId, approval: ApprovalRequest, decision: ApprovalDecision) => {
    await approvals.decide(approval.id, decision);
    setMissing(current => ({ ...current, [appId]: (current[appId] ?? []).filter(item => item.id !== approval.id) }));
  };

  return (
    <ChromeRoot>
      <section aria-labelledby="vendo-automations-heading" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="vendo-automations-heading" className="fl-auto-title" style={{ margin: 0 }}>Automations</h2>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        {automations.automations.length === 0 ? <p className="fl-auto-sub" style={{ margin: 0 }}>No automations yet.</p> : null}
        {automations.automations.map(entry => {
          const appId = entry.app.id;
          const appRuns = runs[appId];
          return (
            <article className="fl-automation" key={appId}>
              <div className="fl-auto-head">
                <span className="fl-auto-ic" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m13 2-9 12h8l-1 8 9-12h-8l1-8Z" />
                  </svg>
                </span>
                <div>
                  <div className="fl-auto-title">{entry.app.name}</div>
                  <div className="fl-auto-sub">
                    {entry.enabled ? <span className="fl-auto-live" aria-hidden="true" /> : null}
                    {entry.enabled ? "Enabled" : "Disabled"}
                  </div>
                </div>
                <button
                  className="fl-auto-toggle"
                  type="button"
                  role="switch"
                  aria-label={entry.enabled ? "Enabled" : "Disabled"}
                  aria-checked={entry.enabled}
                  disabled={busy[`toggle-${appId}`]}
                  style={{
                    background: entry.enabled ? "var(--vendo-accent)" : "var(--vendo-border-strong)",
                    transform: entry.enabled ? undefined : "rotate(180deg)",
                  }}
                  onClick={() => void during(`toggle-${appId}`, async () => {
                    if (entry.enabled) {
                      await automations.disable(appId);
                      setMissing(current => ({ ...current, [appId]: [] }));
                    } else {
                      const result = await automations.enable(appId);
                      setMissing(current => ({ ...current, [appId]: result.missing }));
                    }
                  })}
                />
              </div>

              <div className="fl-auto-flow" style={{ gap: 8 }}>
                <button className="fl-btn" type="button" onClick={() => void during(`plan-${appId}`, async () => {
                  const plan = await automations.dryRun(appId);
                  setPlans(current => ({ ...current, [appId]: plan }));
                })}>Dry run</button>
                <button
                  className="fl-btn"
                  type="button"
                  aria-expanded={appRuns !== undefined}
                  onClick={() => void during(`runs-${appId}`, async () => {
                    if (appRuns !== undefined) {
                      setRuns(current => ({ ...current, [appId]: undefined }));
                    } else {
                      const result = await automations.runs({ appId });
                      setRuns(current => ({ ...current, [appId]: result.runs }));
                    }
                  })}
                >Run history</button>
              </div>

              {(missing[appId] ?? []).map(approval => (
                <ApprovalCard key={approval.id} approval={approval} onDecide={decision => decide(appId, approval, decision)} />
              ))}

              {plans[appId] ? (
                <div
                  className="fl-auto-flow"
                  aria-label={`Dry run for ${entry.app.name}`}
                  style={{ alignItems: "stretch", flexDirection: "column", gap: 10 }}
                >
                  <strong className="fl-auto-title">Dry-run plan</strong>
                  <ol style={{ alignItems: "stretch", display: "flex", listStyle: "none", margin: 0, padding: 0 }}>
                    {plans[appId]!.steps.map((step, index) => (
                      <li key={step.id} style={{ alignItems: "center", display: "flex", flex: 1 }}>
                        {index > 0 ? <span className="fl-auto-arrow" aria-hidden="true" /> : null}
                        <span className="fl-auto-node" style={{ flex: 1 }}>
                          <span className="fl-auto-node-ic" aria-hidden="true">{step.wouldAsk ? "?" : "✓"}</span>
                          <span>
                            <span className="fl-auto-node-t">{step.tool} — {step.wouldAsk ? "would ask" : "ready"}</span>
                            <span className="fl-auto-node-s" style={{ display: "block" }}>Step {index + 1}</span>
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                  <div className="fl-auto-sub">Missing grants: {plans[appId]!.grantsMissing.length ? plans[appId]!.grantsMissing.join(", ") : "none"}</div>
                </div>
              ) : null}

              {appRuns !== undefined ? (
                <div className="fl-act-body" aria-label={`Run history for ${entry.app.name}`}>
                  {appRuns.length === 0 ? <p className="fl-act-row">No runs yet.</p> : appRuns.map(run => (
                    <article key={run.id}>
                      <div className="fl-act-row">
                        <span className={`fl-act-ic ${run.status === "error" ? "fl-act-x" : "fl-act-tick"}`} aria-hidden="true">
                          {run.status === "error" ? "✕" : "✓"}
                        </span>
                        <strong className="fl-act-lbl">{run.status}</strong>
                        <time className="fl-act-sub" dateTime={run.startedAt}>{run.startedAt}</time>
                        {run.status === "running" ? (
                          <button className="fl-btn fl-btn-ceremony" type="button" onClick={() => void during(`stop-${run.id}`, async () => {
                            await automations.stopRun(run.id);
                            setRuns(current => ({
                              ...current,
                              [appId]: (current[appId] ?? []).map(item => item.id === run.id ? { ...item, status: "stopped" } : item),
                            }));
                          })}>Stop</button>
                        ) : null}
                      </div>
                      {run.summary ? <p className="fl-act-peek">{run.summary}</p> : null}
                      {run.error ? <p role="alert" className="fl-error">{run.error.code}: {run.error.message}</p> : null}
                    </article>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </section>
    </ChromeRoot>
  );
}
