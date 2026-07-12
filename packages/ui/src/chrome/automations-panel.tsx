import type { ApprovalRequest, AppId, ApprovalDecision, Trigger } from "@vendoai/core";
import { useEffect, useRef, useState } from "react";
import { useVendoTheme } from "../context.js";
import { useApprovals } from "../hooks/use-approvals.js";
import { useAutomations } from "../hooks/use-automations.js";
import type { RunPlan, RunRecord } from "../wire-types.js";
import { ApprovalCard } from "./approval-card.js";
import { ChromeRoot } from "./chrome-root.js";

const ENABLE_CELEBRATION_MS = 3_100;
const REDUCED_ENABLE_CELEBRATION_MS = 900;

function humanize(value: string): string {
  const words = value
    .replace(/^host[_:. -]?/i, "")
    .replace(/^fn:/i, "")
    .replace(/[._:-]+/g, " ")
    .trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : value;
}

function triggerLabel(trigger: Trigger): { title: string; sub: string } {
  const source = trigger.on;
  if (source.kind === "schedule") {
    if (source.every) return { title: `Every ${source.every}`, sub: "Schedule" };
    if (source.at) return { title: source.at, sub: "Scheduled once" };
    return { title: source.cron ?? "Scheduled", sub: "Schedule" };
  }
  if (source.kind === "external") {
    return { title: humanize(source.event), sub: humanize(source.connector) };
  }
  return { title: humanize(source.event), sub: "Host event" };
}

function automationFlow(trigger: Trigger | undefined): {
  trigger: { title: string; sub: string };
  action: { title: string; sub: string };
} | undefined {
  if (!trigger) return undefined;
  if (trigger.run.kind === "agentic") {
    const prompt = trigger.run.prompt.trim();
    if (!prompt) return undefined;
    return {
      trigger: triggerLabel(trigger),
      action: {
        title: prompt.length > 68 ? `${prompt.slice(0, 67).trimEnd()}…` : prompt,
        sub: "Agent run",
      },
    };
  }
  const firstStep = trigger.run.steps[0];
  if (!firstStep) return undefined;
  return {
    trigger: triggerLabel(trigger),
    action: {
      title: humanize(firstStep.tool),
      sub: trigger.run.steps.length === 1 ? "1 action" : `${trigger.run.steps.length} steps`,
    },
  };
}

/** 08-ui §4; 07-automations §5 — controls, grant capture, previews, history, kill switch. */
export function AutomationsPanel() {
  const automations = useAutomations();
  const approvals = useApprovals();
  const theme = useVendoTheme();
  const [missing, setMissing] = useState<Record<AppId, ApprovalRequest[]>>({});
  const [plans, setPlans] = useState<Record<AppId, RunPlan | undefined>>({});
  const [runs, setRuns] = useState<Record<AppId, RunRecord[] | undefined>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string>();
  const [justEnabled, setJustEnabled] = useState<Record<AppId, boolean>>({});
  const enableTimers = useRef(new Map<AppId, number>());

  useEffect(() => () => {
    for (const timer of enableTimers.current.values()) window.clearTimeout(timer);
    enableTimers.current.clear();
  }, []);

  const clearEnableCelebration = (appId: AppId) => {
    const timer = enableTimers.current.get(appId);
    if (timer !== undefined) window.clearTimeout(timer);
    enableTimers.current.delete(appId);
    setJustEnabled(current => {
      if (!current[appId]) return current;
      const next = { ...current };
      delete next[appId];
      return next;
    });
  };

  const celebrateEnable = (appId: AppId) => {
    const existing = enableTimers.current.get(appId);
    if (existing !== undefined) window.clearTimeout(existing);
    const reduced = theme.motion === "reduced"
      || (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    setJustEnabled(current => ({ ...current, [appId]: true }));
    enableTimers.current.set(appId, window.setTimeout(
      () => clearEnableCelebration(appId),
      reduced ? REDUCED_ENABLE_CELEBRATION_MS : ENABLE_CELEBRATION_MS,
    ));
  };

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
          const flow = automationFlow(entry.app.trigger);
          const celebrating = justEnabled[appId] === true;
          const reduced = theme.motion === "reduced"
            || (typeof window !== "undefined" && typeof window.matchMedia === "function"
              && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
          return (
            <article
              className="fl-automation"
              key={appId}
              style={celebrating && !reduced
                ? { animation: "fl-connect-bloom .5s cubic-bezier(.22,1,.36,1) both" }
                : undefined}
            >
              <div className="fl-auto-head">
                <span className="fl-auto-ic" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m13 2-9 12h8l-1 8 9-12h-8l1-8Z" />
                  </svg>
                </span>
                <div>
                  <div className="fl-auto-title">{entry.app.name}</div>
                  <div className="fl-auto-sub">
                    {entry.enabled ? (
                      <span
                        className="fl-auto-live"
                        aria-hidden="true"
                        style={celebrating && !reduced
                          ? { animation: "fl-connect-pop .55s cubic-bezier(.22,1,.36,1) both" }
                          : undefined}
                      />
                    ) : null}
                    {entry.enabled ? "Enabled" : "Disabled"}
                  </div>
                </div>
                <button
                  className="fl-auto-toggle"
                  type="button"
                  role="switch"
                  // Name identifies WHICH automation (aria-checked carries the on/off
                  // state) so screen readers and role/name tests can tell two same-state
                  // toggles apart and never flip the wrong app.
                  aria-label={`Enable ${entry.app.name}`}
                  aria-checked={entry.enabled}
                  disabled={busy[`toggle-${appId}`]}
                  style={{
                    background: entry.enabled ? "var(--vendo-accent)" : "var(--vendo-border-strong)",
                    transform: entry.enabled ? undefined : "rotate(180deg)",
                    transition: "background .2s ease, transform .2s cubic-bezier(.22,1,.36,1)",
                  }}
                  onClick={() => void during(`toggle-${appId}`, async () => {
                    if (entry.enabled) {
                      await automations.disable(appId);
                      clearEnableCelebration(appId);
                      setMissing(current => ({ ...current, [appId]: [] }));
                    } else {
                      const result = await automations.enable(appId);
                      setMissing(current => ({ ...current, [appId]: result.missing }));
                      if (result.enabled) celebrateEnable(appId);
                    }
                  })}
                />
              </div>

              {flow ? (
                <div className="fl-auto-flow" aria-label={`Automation flow for ${entry.app.name}`}>
                  <span className="fl-auto-node" style={{ flex: 1 }}>
                    <span className="fl-auto-node-ic" aria-hidden="true">↳</span>
                    <span>
                      <span className="fl-auto-node-t">{flow.trigger.title}</span>
                      <span className="fl-auto-node-s" style={{ display: "block" }}>{flow.trigger.sub}</span>
                    </span>
                  </span>
                  <span className="fl-auto-arrow" aria-hidden="true" />
                  <span className="fl-auto-node" style={{ flex: 1 }}>
                    <span className="fl-auto-node-ic" aria-hidden="true">✓</span>
                    <span>
                      <span className="fl-auto-node-t">{flow.action.title}</span>
                      <span className="fl-auto-node-s" style={{ display: "block" }}>{flow.action.sub}</span>
                    </span>
                  </span>
                </div>
              ) : null}

              {celebrating ? (
                <div
                  className="fl-auto-created-toast"
                  role="status"
                  aria-live="polite"
                  style={!reduced
                    ? { animation: "fl-item-in .24s ease-out 2.82s reverse both" }
                    : undefined}
                >
                  <span className="fl-auto-created-live" aria-hidden="true" />
                  <div className="fl-auto-created-copy">
                    <div className="fl-auto-created-title">{entry.app.name} is live</div>
                    <div className="fl-auto-created-sub">Automation enabled</div>
                  </div>
                </div>
              ) : null}

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
