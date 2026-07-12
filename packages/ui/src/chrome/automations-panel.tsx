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
      <section className="vendo-stack" aria-labelledby="vendo-automations-heading">
        <h2 id="vendo-automations-heading">Automations</h2>
        {error ? <div role="alert" className="vendo-danger">{error}</div> : null}
        {automations.automations.length === 0 ? <p>No automations yet.</p> : null}
        {automations.automations.map(entry => {
          const appId = entry.app.id;
          const appRuns = runs[appId];
          return (
            <article className="vendo-card vendo-stack" key={appId}>
              <div className="vendo-row">
                <strong>{entry.app.name}</strong>
                <button
                  type="button"
                  role="switch"
                  aria-checked={entry.enabled}
                  disabled={busy[`toggle-${appId}`]}
                  onClick={() => void during(`toggle-${appId}`, async () => {
                    if (entry.enabled) {
                      await automations.disable(appId);
                      setMissing(current => ({ ...current, [appId]: [] }));
                    } else {
                      const result = await automations.enable(appId);
                      setMissing(current => ({ ...current, [appId]: result.missing }));
                    }
                  })}
                >
                  {entry.enabled ? "Enabled" : "Disabled"}
                </button>
                <button type="button" onClick={() => void during(`plan-${appId}`, async () => {
                  const plan = await automations.dryRun(appId);
                  setPlans(current => ({ ...current, [appId]: plan }));
                })}>Dry run</button>
                <button
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
                <div className="vendo-run-plan vendo-stack" aria-label={`Dry run for ${entry.app.name}`}>
                  <strong>Dry-run plan</strong>
                  <ol>
                    {plans[appId]!.steps.map(step => <li key={step.id}>{step.tool} — {step.wouldAsk ? "would ask" : "ready"}</li>)}
                  </ol>
                  <div>Missing grants: {plans[appId]!.grantsMissing.length ? plans[appId]!.grantsMissing.join(", ") : "none"}</div>
                </div>
              ) : null}

              {appRuns !== undefined ? (
                <div className="vendo-stack" aria-label={`Run history for ${entry.app.name}`}>
                  {appRuns.length === 0 ? <p>No runs yet.</p> : appRuns.map(run => (
                    <article className="vendo-card" key={run.id}>
                      <div className="vendo-row">
                        <strong>{run.status}</strong>
                        <time dateTime={run.startedAt}>{run.startedAt}</time>
                        {run.status === "running" ? (
                          <button className="vendo-danger" type="button" onClick={() => void during(`stop-${run.id}`, async () => {
                            await automations.stopRun(run.id);
                            setRuns(current => ({
                              ...current,
                              [appId]: (current[appId] ?? []).map(item => item.id === run.id ? { ...item, status: "stopped" } : item),
                            }));
                          })}>Stop</button>
                        ) : null}
                      </div>
                      {run.summary ? <p>{run.summary}</p> : null}
                      {run.error ? <p role="alert" className="vendo-danger">{run.error.code}: {run.error.message}</p> : null}
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
