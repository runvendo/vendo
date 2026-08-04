import { serviceToolSlug, type ApprovalRequest, type AppId, type Trigger } from "@vendoai/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { APPROVALS_DECIDED_EVENT } from "../client-impl.js";
import { useVendoContext, useVendoTheme } from "../context.js";
import { useApprovals } from "../hooks/use-approvals.js";
import { useAutomations } from "../hooks/use-automations.js";
import type { RunPlan, RunRecord, RunStatus } from "../wire-types.js";
import { formatAuditTime } from "./activity-semantics.js";
import { automationFlow, sponsorLabel } from "./automation-card.js";
import { ChromeRoot } from "./chrome-root.js";
import { developmentMode } from "./dev-mode.js";
import { GrantSetCard } from "./grant-set-card.js";

const ENABLE_CELEBRATION_MS = 3_100;
const REDUCED_ENABLE_CELEBRATION_MS = 900;

/** ui-lane-panels pick B — the last-10-runs dot strip. */
const RUN_STRIP_LIMIT = 10;
const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  ok: "Succeeded",
  error: "Failed",
  running: "Running",
  stopped: "Stopped",
  "pending-approval": "Waiting on approval",
};
const RUN_STATUS_ROLLUP: Record<RunStatus, string> = {
  ok: "ok",
  error: "failed",
  running: "running",
  stopped: "stopped",
  "pending-approval": "waiting",
};

/** "8 ok · 1 failed · 1 waiting" — text rollup so colour is never the only
    signal on the strip. Statuses appear in a fixed order, zero-counts drop. */
function runRollup(runs: RunRecord[]): string {
  const counts = new Map<RunStatus, number>();
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  const order: RunStatus[] = ["ok", "error", "pending-approval", "running", "stopped"];
  return order
    .filter(status => counts.has(status))
    .map(status => `${counts.get(status)} ${RUN_STATUS_ROLLUP[status]}`)
    .join(" · ");
}

/**
 * The consumer's half of a refusal (design §3, the consumer-voice law). Every
 * sentence the wire throws is written for the HOST DEVELOPER — one names an
 * environment variable, another carries an app id — and rendering
 * `reason.message` put all of them in front of whoever was using the product.
 * The developer sentence keeps its home (the server's own error, the browser
 * console); the person reading this panel is told what it means for THEM. Same
 * treatment the Share dialog (`refusalCopy`) and the apps page
 * (`refusalSentence`) already carry.
 *
 * One sentence per code, not per verb: turning an automation on, dry-running
 * it, reading its history and stopping a run all fail for the same few reasons,
 * and the code is the part that differs.
 */
function refusalCopy(reason: unknown): string {
  const code = (reason as { code?: unknown } | null)?.code;
  if (code === "forbidden") return "You can see this automation, but not change it.";
  if (code === "not-found") return "That automation isn’t available any more.";
  if (code === "cloud-required") return "That isn’t turned on for this workspace yet.";
  return "That didn’t go through — nothing changed. Try again in a moment.";
}

/** Lane pick 7-A — liveness. `every` durations the wire uses ("30m", "6h",
    "1d", "1w"); anything unparseable yields no countdown (the flow node's
    "Every …" label already states the cadence). */
const EVERY_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function everyToMs(every: string): number | undefined {
  const match = /^(\d+)\s*([smhdw])$/.exec(every.trim());
  if (!match) return undefined;
  const unit = EVERY_UNIT_MS[match[2]!];
  return unit === undefined ? undefined : Number(match[1]) * unit;
}

function formatEta(ms: number): string {
  if (ms < 60_000) return "in under a minute";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `in ${days} d${hours > 0 ? ` ${hours} h` : ""}`;
  if (hours > 0) return `in ${hours} h${rest > 0 ? ` ${rest} m` : ""}`;
  return `in ${rest} m`;
}

/** "next run in 6 h 12 m" — computed only from REAL data: a parseable
    schedule plus (for recurring schedules) the last run's actual start time.
    No runs yet or an unparseable cadence → null, and the line stays quiet. */
function nextRunLabel(trigger: Trigger | undefined, lastStartedAt: string | undefined, now: number): string | null {
  if (!trigger || trigger.on.kind !== "schedule") return null;
  const source = trigger.on;
  if (source.at) {
    const at = Date.parse(source.at);
    if (Number.isNaN(at) || at <= now) return null;
    return `next run ${formatEta(at - now)}`;
  }
  if (source.every && lastStartedAt) {
    const period = everyToMs(source.every);
    const last = Date.parse(lastStartedAt);
    if (period === undefined || Number.isNaN(last)) return null;
    const next = last + period;
    if (next <= now) return "next run due now";
    return `next run ${formatEta(next - now)}`;
  }
  return null;
}

/** 08-ui §4; 07-automations §5 — controls, grant capture, previews, history, kill switch.
    The trigger/flow labels (triggerLabel, automationFlow) moved to
    automation-card.tsx (2026-07 demo feedback), shared with the read-only
    in-thread AutomationCard. */
export function AutomationsPanel() {
  const automations = useAutomations();
  const approvals = useApprovals();
  const { client } = useVendoContext();
  const theme = useVendoTheme();
  const [plans, setPlans] = useState<Record<AppId, RunPlan | undefined>>({});
  const [runs, setRuns] = useState<Record<AppId, RunRecord[] | undefined>>({});
  const [recent, setRecent] = useState<Record<AppId, RunRecord[] | undefined>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string>();
  const [justEnabled, setJustEnabled] = useState<Record<AppId, boolean>>({});
  const enableTimers = useRef(new Map<AppId, number>());
  const stripFetched = useRef(new Set<AppId>());
  // 7-A — the countdown re-renders on a slow clock; minute precision needs no
  // faster tick, and an unmounted panel stops it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    for (const timer of enableTimers.current.values()) window.clearTimeout(timer);
    enableTimers.current.clear();
  }, []);

  // A decision on ANY surface (the in-thread set card decides the same guard
  // asks) must clear this panel's pending rows too — same announcement the
  // thread listens to. Refs keep the subscription mount-stable.
  const refreshRef = useRef<() => void>(() => undefined);
  refreshRef.current = () => {
    void approvals.refresh();
    void automations.refresh();
  };
  useEffect(() => {
    const onDecided = () => refreshRef.current();
    window.addEventListener(APPROVALS_DECIDED_EVENT, onDecided);
    return () => window.removeEventListener(APPROVALS_DECIDED_EVENT, onDecided);
  }, []);

  // Eager last-N-runs fetch per card (pick B): the strip answers "is this
  // automation healthy" without opening Run history. Once per appId; a strip
  // fetch failure stays silent-but-visible — the strip simply doesn't render,
  // and Run history still surfaces errors through the shared alert.
  const listRuns = automations.runs;
  useEffect(() => {
    let cancelled = false;
    for (const entry of automations.automations) {
      const appId = entry.app.id;
      if (stripFetched.current.has(appId)) continue;
      stripFetched.current.add(appId);
      void (async () => {
        try {
          const result = await listRuns({ appId });
          // A discarded (cancelled) response must also unmark the appId, or an
          // effect restart would skip its only retry and the strip never renders.
          if (cancelled) {
            stripFetched.current.delete(appId);
            return;
          }
          setRecent(current => ({ ...current, [appId]: result.runs.slice(0, RUN_STRIP_LIMIT) }));
        } catch {
          if (!cancelled) stripFetched.current.delete(appId);
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [automations.automations, listRuns]);

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
      setError(refusalCopy(reason));
    } finally {
      setBusy(current => ({ ...current, [key]: false }));
    }
  };

  // Outstanding standing-grant asks per automation, derived from the PERSISTED
  // pending approvals (grant-set reload survival): the asks a page reload
  // re-fetches, never an enable() result held in component state.
  const pendingByApp = useMemo(() => {
    const byApp = new Map<AppId, ApprovalRequest[]>();
    for (const ask of approvals.pending) {
      if (ask.ctx.venue !== "automation" || ask.ctx.appId === undefined) continue;
      byApp.set(ask.ctx.appId, [...(byApp.get(ask.ctx.appId) ?? []), ask]);
    }
    return byApp;
  }, [approvals.pending]);

  /** Decide the app's WHOLE grant set with one wire call (atomic per
      criterion: all granted or none — the guard lands the batch all-or-none,
      and a wholly denied set disarms its automation inside the SAME decision).
      The announcement carries the set id so a thread parked on this set
      resumes from here. A thrown decide surfaces in the card (visible error +
      the actions stay, so retrying is one click). After a deny, the panel
      VERIFIES the disarm landed and repairs with an explicit disable when it
      did not; a failed repair surfaces in the panel alert with the row
      honestly still Enabled and the toggle as the retry — a denied automation
      is never silently left enabled. */
  const decideSet = async (appId: AppId, asks: ApprovalRequest[], grantSetId: string | undefined, approve: boolean) => {
    await approvals.decide(
      asks.map(ask => ask.id),
      { approve },
      grantSetId === undefined ? undefined : { grantSetId },
    );
    await automations.refresh();
    if (approve) return;
    const [entries, grants] = await Promise.all([client.automations.list(), client.grants.list()]);
    const entry = entries.find(candidate => candidate.app.id === appId);
    const stillArmed = entry !== undefined && entry.enabled && (entry.pendingGrants ?? 0) === 0;
    // The engine keeps a PARTIALLY granted automation armed by design (its
    // ungranted steps park at fire time) — repair only a consent moment that
    // granted nothing yet left the row enabled.
    const grantedSomething = grants.some(grant =>
      grant.appId === appId
      && grant.source === "automation"
      && grant.duration === "standing"
      && grant.revokedAt === undefined);
    if (!stillArmed || grantedSomething) return;
    try {
      await automations.disable(appId);
    } catch (reason) {
      // Same rule as a failed run: what did not happen, and what is still true.
      // The wire's sentence goes to the developer's own channel.
      if (developmentMode()) console.warn("[vendo] switching the automation off after a denial failed:", reason);
      setError(
        "You said no to those permissions, but this automation could not be switched off."
        + " It is still enabled — use its toggle to turn it off.",
      );
    }
  };

  // Evaluated once per render (not once per automation): matchMedia is cheap but
  // querying it inside the list map was needless repeated work.
  const reduced = theme.motion === "reduced"
    || (typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

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
          const runsAs = sponsorLabel(entry.sponsor, entry.editors);
          // The set-card rows come from the persisted pending queue; the count
          // prefers the engine's own projection (they agree modulo poll skew).
          const pendingAsks = pendingByApp.get(appId) ?? [];
          const waitingOn = entry.pendingGrants ?? pendingAsks.length;
          const celebrating = justEnabled[appId] === true;
          // Oldest → newest left-to-right, so the strip reads like a timeline.
          const strip = recent[appId]?.slice().reverse();
          // 7-A liveness — a running run puts the traveling dot on the arrow
          // and takes over the state line; otherwise the enabled line carries
          // the next-run countdown when it can be computed honestly. The
          // expanded history is fresher than the strip when both exist.
          const known = runs[appId] ?? recent[appId];
          const runningRun = known?.find(run => run.status === "running");
          // "step N/M": M = the plan's step count, N = the step in flight
          // (recorded steps + 1). Plans without steps just say "running now".
          const plannedSteps = entry.app.trigger?.run.kind === "steps" ? entry.app.trigger.run.steps.length : 0;
          const runningStep = runningRun && plannedSteps > 0
            ? ` · step ${Math.min(runningRun.steps.length + 1, plannedSteps)}/${plannedSteps}`
            : "";
          // Latest start by value, not position — storage pages are not
          // guaranteed newest-first (ISO instants compare lexically).
          const lastStartedAt = known?.reduce<string | undefined>(
            (latest, run) => (!latest || run.startedAt > latest ? run.startedAt : latest),
            undefined,
          );
          const nextRun = entry.enabled && !runningRun
            ? nextRunLabel(entry.app.trigger, lastStartedAt, now)
            : null;
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
                    {/* §9.9 — `stopped` is the SERVER's word on the automation
                        itself and it outranks any run row: the fire-time check
                        stops a run before its first tool call, so a run left
                        looking live cannot be allowed to report "running now"
                        about something that will not run again until it is
                        taken on. */}
                    {entry.stopped !== undefined ? (
                      <>
                        <span className="fl-auto-live fl-auto-wait" aria-hidden="true" />
                        Stopped
                      </>
                    ) : runningRun ? (
                      <>
                        <span className="fl-act-spin" aria-hidden="true" />
                        <span className="fl-auto-nextrun">running now{runningStep}</span>
                      </>
                    ) : (
                      <>
                        {entry.enabled ? (
                          <span
                            className={`fl-auto-live${waitingOn > 0 ? " fl-auto-wait" : ""}`}
                            aria-hidden="true"
                            style={celebrating && !reduced
                              ? { animation: "fl-connect-pop .55s cubic-bezier(.22,1,.36,1) both" }
                              : undefined}
                          />
                        ) : null}
                        {entry.enabled
                          ? waitingOn > 0
                            ? `Enabled · waiting on ${waitingOn} permission${waitingOn === 1 ? "" : "s"}`
                            : "Enabled"
                          : "Disabled"}
                        {nextRun ? <span className="fl-auto-nextrun">· {nextRun}</span> : null}
                      </>
                    )}
                  </div>
                  {/* §9.9 — WHY it stopped, in the server's own consumer sentence
                      (the same one the adoption card carries, so the list and the
                      card never say two different things). The card in the app is
                      where it gets taken on; this is how it gets found. */}
                  {entry.stopped === undefined ? null : (
                    <div className="fl-auto-sub fl-auto-stopped" style={{ display: "block" }} role="status">
                      {entry.stopped.summary}
                    </div>
                  )}
                  {/* §13 — an automation always runs as a named person, and its
                      window says so. */}
                  {runsAs === null
                    ? null
                    : <div className="fl-auto-sub" style={{ display: "block" }}>{runsAs}</div>}
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
                    // OFF has to be VISIBLE as a state (WCAG 1.4.11): the 14%
                    // hairline track sat at ~1.4:1, so "off" read as "no
                    // control here". --vendo-indicator is the 3:1 derivation.
                    background: entry.enabled ? "var(--vendo-accent)" : "var(--vendo-indicator)",
                    transform: entry.enabled ? undefined : "rotate(180deg)",
                    transition: "background .2s ease, transform .2s cubic-bezier(.22,1,.36,1)",
                  }}
                  onClick={() => void during(`toggle-${appId}`, async () => {
                    if (entry.enabled) {
                      await automations.disable(appId);
                      clearEnableCelebration(appId);
                    } else {
                      const result = await automations.enable(appId);
                      // The minted asks land in the persisted pending queue;
                      // re-fetch it so the grant-set card renders from the
                      // same source a reload would use.
                      await approvals.refresh();
                      if (result.enabled && result.missing.length === 0) celebrateEnable(appId);
                    }
                  })}
                />
              </div>

              {/* role="group": a bare <div> may not carry aria-label (axe
                  aria-prohibited-attr) — and this IS a group, the two labelled
                  nodes of one trigger→action flow. */}
              {flow ? (
                <div className="fl-auto-flow" role="group" aria-label={`Automation flow for ${entry.app.name}`}>
                  <span className="fl-auto-node" style={{ flex: 1 }}>
                    <span className="fl-auto-node-ic" aria-hidden="true">↳</span>
                    <span>
                      <span className="fl-auto-node-t">{flow.trigger.title}</span>
                      <span className="fl-auto-node-s" style={{ display: "block" }}>{flow.trigger.sub}</span>
                    </span>
                  </span>
                  <span className="fl-auto-arrow" aria-hidden="true">
                    {runningRun ? <span className="fl-auto-runner" /> : null}
                  </span>
                  <span className="fl-auto-node" style={{ flex: 1 }}>
                    <span className="fl-auto-node-ic" aria-hidden="true">✓</span>
                    <span>
                      <span className="fl-auto-node-t">{flow.action.title}</span>
                      <span className="fl-auto-node-s" style={{ display: "block" }}>{flow.action.sub}</span>
                    </span>
                  </span>
                </div>
              ) : null}

              {/* role="img": the dots and the rollup are all aria-hidden, so
                  the label IS the whole content — a graphic with a text
                  alternative, which is what role=img means. */}
              {strip && strip.length > 0 ? (
                <div className="fl-auto-runs" role="img" aria-label={`Last ${strip.length} run${strip.length === 1 ? "" : "s"} for ${entry.app.name}: ${runRollup(strip)}`}>
                  <span className="fl-auto-runs-lbl" aria-hidden="true">Last {strip.length} run{strip.length === 1 ? "" : "s"}</span>
                  {strip.map(run => (
                    <span
                      key={run.id}
                      className="fl-auto-runs-dot"
                      data-status={run.status}
                      title={`${RUN_STATUS_LABEL[run.status]} · ${formatAuditTime(run.startedAt)}`}
                      aria-hidden="true"
                    />
                  ))}
                  <span className="fl-auto-runs-sum" aria-hidden="true">{runRollup(strip)}</span>
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

              {pendingAsks.length > 0 ? (
                <GrantSetCard
                  name={entry.app.name}
                  permissions={pendingAsks.map(ask => {
                    // A connector ask is FOR its service action, not for the
                    // dispatcher — two service actions are otherwise the same
                    // row twice.
                    const slug = serviceToolSlug(ask.call);
                    return {
                      approvalId: ask.id,
                      tool: ask.call.tool,
                      ...(slug === undefined ? {} : { slug }),
                      risk: ask.descriptor.risk,
                    };
                  })}
                  state="parked"
                  onDecide={async approve => {
                    await decideSet(appId, pendingAsks, entry.grantSetId, approve);
                    if (approve) celebrateEnable(appId);
                  }}
                />
              ) : null}

              {plans[appId] ? (
                <div
                  className="fl-auto-flow"
                  // role="group": a bare <div> may not carry aria-label
                  // (aria-prohibited-attr) — same fix as the flow block above.
                  role="group"
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
                <div className="fl-act-body" role="group" aria-label={`Run history for ${entry.app.name}`}>
                  {appRuns.length === 0 ? <p className="fl-act-row">No runs yet.</p> : appRuns.map(run => (
                    <article key={run.id}>
                      <div className="fl-act-row">
                        <span className={`fl-act-ic ${run.status === "error" ? "fl-act-x" : "fl-act-tick"}`} aria-hidden="true">
                          {run.status === "error" ? "✕" : "✓"}
                        </span>
                        <strong className="fl-act-lbl">{RUN_STATUS_LABEL[run.status]}</strong>
                        <time className="fl-act-sub" dateTime={run.startedAt}>{formatAuditTime(run.startedAt)}</time>
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
                      {/* Ruling 11 — a failed UNATTENDED run tells its owner what
                          did not happen and that nothing changed. The run's own
                          code and reason are written for whoever runs the
                          deployment (the scheduler's refusals name billing
                          allowances and console URLs), so they ride the dev-mode
                          rail — the same seam the queue row's server preview
                          uses. */}
                      {run.error ? (
                        <>
                          <p role="alert" className="fl-error">
                            {`This run didn’t finish — nothing in your account was changed.`}
                          </p>
                          {developmentMode()
                            ? <p className="fl-act-sub">{`${run.error.code}: ${run.error.message}`}</p>
                            : null}
                        </>
                      ) : null}
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
