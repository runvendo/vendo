import type { ApprovalRequest, AppId, Trigger } from "@vendoai/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { APPROVALS_DECIDED_EVENT } from "../client-impl.js";
import { useVendoContext, useVendoTheme } from "../context.js";
import { useApprovals } from "../hooks/use-approvals.js";
import { useAutomations } from "../hooks/use-automations.js";
import type { RehearsalFiring, RehearsalReport, RehearsalStep, RunPlan, RunRecord, RunStatus } from "../wire-types.js";
import { formatAuditTime } from "./activity-semantics.js";
import { automationFlow } from "./automation-card.js";
import { ChromeRoot } from "./chrome-root.js";
import { GrantSetCard } from "./grant-set-card.js";
import { humanizeToolName } from "./humanize.js";
import { Money } from "../kit/values.js";

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

/** "Jul 18" — short day label for rehearsal windows and firing rows. */
function formatRehearsalDay(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Firings-box sizing (item: fixed 320px left a mostly-empty box for short
    lists). One collapsed firing row ≈ .fl-act-row (8+8px padding + line;
    measured ≈ 40px in the demo); REHEARSAL_BODY_MAX_PX is the original ceiling
    above which the box scrolls internally; REHEARSAL_BODY_PAD_PX is
    .fl-act-body's vertical padding. */
const REHEARSAL_FIRING_ROW_PX = 40;
const REHEARSAL_BODY_PAD_PX = 6;
const REHEARSAL_BODY_MAX_PX = 320;

const REHEARSAL_FIRING_LABEL: Record<RehearsalFiring["status"], string> = {
  fired: "fired",
  skipped: "skipped",
  error: "stopped",
};

/** "dining" → "Dining", "Maple Checking" → "Maple Checking": Title-case each
    word so a lowercase enum label (the spending category) reads as a proper
    noun while an already-cased account name stays untouched. */
function titleCase(label: string): string {
  return label.replace(/\b\w/g, char => char.toUpperCase());
}

/** The one resolved number a firing surfaces on its single line: the first ok
    read that carried a numeric summary (a schedule's headline read runs first,
    e.g. the spending total ahead of the transaction list). */
function firingHeadline(firing: RehearsalFiring): RehearsalStep["result"] | undefined {
  return firing.steps.find(step => step.status === "ok" && step.result !== undefined)?.result;
}

/** How many of a firing's simulated writes would NOT simply run once live — a
    policy block, or a call that would still ask for approval (missing grant /
    critical). Surfaced on the collapsed firing row so an honest "would ask"
    verdict is visible without expanding. */
function firingWouldStopCount(firing: RehearsalFiring): number {
  return firing.steps.filter(step =>
    step.status === "simulated" && (step.wouldBlock !== undefined || step.wouldAsk === true)).length;
}

/** One rehearsed step, shown only in a firing's expanded detail: reads show
    what they ran against (the pinned window, or "today's data" when the tool
    takes no date bounds) plus a per-item money breakdown when the resolved
    output had one; simulated writes render as the simulated-action card with
    their resolved arguments — the exact call the enabled automation would have
    made, never executed. */
function RehearsalStepRow({ step }: { step: RehearsalStep }) {
  const name = humanizeToolName(step.tool);
  if (step.status === "simulated") {
    // The honest verdict the guard resolved for this write (07-automations):
    // a plain simulated action would run once live, but a would-block or
    // would-ask one would NOT — the card must say so rather than reading rosy.
    const missing = step.grantsMissing ?? [];
    const grantList = missing.map(humanizeToolName).join(", ");
    const wouldStop = step.wouldBlock !== undefined || step.wouldAsk === true;
    const verdictLabel = step.wouldBlock !== undefined
      ? "would have been blocked"
      : step.wouldAsk === true
        ? "would ask first"
        : "simulated";
    const verdictSub = step.wouldBlock !== undefined
      ? `Would have been blocked — ${step.wouldBlock}`
      : missing.length > 0
        ? `Would have been blocked — missing grant: ${grantList} (needs approval before it runs)`
        : step.wouldAsk === true
          ? "Would have asked for approval first — this action always needs sign-off"
          : "Not executed — this is what it would have sent";
    return (
      <div className="fl-act-row" style={{ alignItems: "flex-start" }}>
        <span className={`fl-act-ic ${wouldStop ? "fl-act-x" : ""}`} aria-hidden="true">{wouldStop ? "⚠" : "✉"}</span>
        <span style={{ minWidth: 0 }}>
          <strong className="fl-act-lbl">{name} — {verdictLabel}</strong>
          <span className="fl-act-sub" style={{ display: "block" }}>{verdictSub}</span>
          {step.args !== undefined && Object.keys(step.args).length > 0 ? (
            <code className="fl-act-peek" style={{ display: "block", overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
              {JSON.stringify(step.args, null, 1)}
            </code>
          ) : null}
        </span>
      </div>
    );
  }
  const scope = step.status === "ok"
    ? step.evaluatedOn === "window" && step.window !== undefined
      ? `${formatRehearsalDay(step.window.from)} → ${formatRehearsalDay(step.window.to)}`
      : step.evaluatedOn === "today"
        ? "today's data"
        : undefined
    : step.detail;
  const result = step.status === "ok" ? step.result : undefined;
  return (
    <>
      <div className="fl-act-row">
        <span className={`fl-act-ic ${step.status === "ok" ? "fl-act-tick" : step.status === "skipped" ? "" : "fl-act-x"}`} aria-hidden="true">
          {step.status === "ok" ? "✓" : step.status === "skipped" ? "–" : "✕"}
        </span>
        <strong className="fl-act-lbl">{name}</strong>
        <span className="fl-act-sub" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {scope !== undefined ? <span>{step.status === "ok" ? scope : `${step.status} · ${scope}`}</span> : step.status !== "ok" ? <span>{step.status}</span> : null}
          {/* A single-value read (no per-item split) carries its number inline;
              a breakdown renders the total below with its items. */}
          {result !== undefined && result.breakdown === undefined ? (
            <strong style={{ color: "var(--vendo-fg)", fontVariantNumeric: "tabular-nums" }}><Money cents={result.totalCents} /></strong>
          ) : null}
        </span>
      </div>
      {result?.breakdown !== undefined ? (
        <div className="fl-act-peek">
          {result.breakdown.map((item, index) => (
            <div className="fl-act-peek-row" key={`${item.label}-${index}`}>
              <span className="fl-act-peek-k">{titleCase(item.label)}</span>
              <span className="fl-act-peek-v"><Money cents={item.cents} /></span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** The rehearsal timeline: one line per firing over the trailing window
    (7 or 30 days — `report.windowDays`), newest first — date/time, fired
    status, and the firing's one resolved headline number (a real read's total,
    formatted in the host's currency). Every firing starts collapsed; its
    per-step detail (the money breakdown, simulated cards) expands on click,
    with no exception for the newest. A small 7d/30d control in the header re-fetches this report over
    the chosen window in place (`onWindowChange`), disabled while `busy`. Purely
    a preview — the header says so, and the enable toggle + grant capture stay
    the one consent path. */
function RehearsalTimeline({
  name,
  report,
  busy,
  onWindowChange,
}: {
  name: string;
  report: RehearsalReport;
  busy: boolean;
  onWindowChange: (windowDays: 7 | 30) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const fired = report.firings.filter(firing => firing.status === "fired").length;
  const simulated = report.firings.reduce((count, firing) => count + firing.simulatedActions, 0);
  const newestFirst = report.firings.slice().reverse();
  // The firings box is sized to fit THIS automation's firings (collapsed),
  // capped at REHEARSAL_BODY_MAX_PX with internal scroll above that — so a
  // weekly schedule with 1-2 firings no longer reserves a mostly-empty 320px
  // box. Height is high-water-marked across renders and NEVER shrinks: the
  // default 30d window (always ≥ the 7d window's firing count) loads first and
  // locks the larger height, so toggling 7d/30d for the same automation can't
  // resize the panel or reflow the cards below it.
  const bodyEstimate = Math.min(
    REHEARSAL_BODY_MAX_PX,
    report.firings.length * REHEARSAL_FIRING_ROW_PX + REHEARSAL_BODY_PAD_PX,
  );
  const [bodyHeight, setBodyHeight] = useState(bodyEstimate);
  useEffect(() => {
    setBodyHeight(prev => Math.max(prev, bodyEstimate));
  }, [bodyEstimate]);
  return (
    <div
      className="fl-auto-flow"
      aria-label={`Rehearsal for ${name}`}
      style={{ alignItems: "stretch", flexDirection: "column", gap: 10 }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 8, justifyContent: "space-between" }}>
        <strong className="fl-auto-title">Rehearsal — last {report.windowDays} days</strong>
        <div
          role="group"
          aria-label="Rehearsal window"
          style={{ display: "inline-flex", flexShrink: 0, gap: 2 }}
        >
          {([7, 30] as const).map(windowDays => {
            const selected = report.windowDays === windowDays;
            return (
              <button
                key={windowDays}
                className="fl-btn"
                type="button"
                aria-pressed={selected}
                disabled={busy || selected}
                onClick={() => onWindowChange(windowDays)}
                style={{
                  fontSize: 11,
                  fontWeight: selected ? 600 : 400,
                  opacity: !selected && busy ? 0.6 : 1,
                  padding: "2px 8px",
                  ...(selected ? { background: "var(--vendo-fg)", color: "var(--vendo-bg)" } : {}),
                }}
              >{windowDays}d</button>
            );
          })}
        </div>
      </div>
      <div className="fl-auto-sub" style={{ display: "block" }}>
        {report.firings.length === 0
          ? `This schedule would not have fired in the last ${report.windowDays} days.`
          : `Would have fired ${fired} time${fired === 1 ? "" : "s"}`
            + (simulated > 0 ? ` · ${simulated} simulated action${simulated === 1 ? "" : "s"} — nothing was executed` : " · nothing was executed")
            + (report.truncated === true ? " · showing the most recent firings" : "")}
      </div>
      {/* Explicit height (not maxHeight), high-water-marked so it never shrinks
          on a 7d/30d toggle: the box holds its size across toggles for the same
          automation — flipping windows only scrolls its inner content instead
          of resizing the panel and reflowing every card below it — but it is
          sized to this automation's firings (capped) rather than always
          reserving 320px, so a short list doesn't leave a mostly-empty box. */}
      {newestFirst.length > 0 ? (
        <div className="fl-act-body" style={{ height: bodyHeight, overflowY: "auto" }}>
          {newestFirst.map(firing => {
            const key = firing.scheduledFor;
            const headline = firingHeadline(firing);
            const hasDetail = firing.steps.length > 0;
            const opened = hasDetail && (open[key] ?? false);
            return (
              <article key={key}>
                <div className="fl-act-row">
                  <span
                    className={`fl-act-ic ${firing.status === "error" ? "fl-act-x" : "fl-act-tick"}`}
                    aria-hidden="true"
                  >
                    {firing.status === "fired" ? "✓" : firing.status === "skipped" ? "–" : "✕"}
                  </span>
                  <strong className="fl-act-lbl">{formatAuditTime(key)}</strong>
                  <span className="fl-act-sub" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span>{REHEARSAL_FIRING_LABEL[firing.status]}</span>
                    {firing.simulatedActions > 0 ? (
                      <span>· {firing.simulatedActions} simulated</span>
                    ) : null}
                    {(() => {
                      const wouldStop = firingWouldStopCount(firing);
                      return wouldStop > 0 ? (
                        <span className="fl-act-x" style={{ fontWeight: 600 }}>· {wouldStop} would ask</span>
                      ) : null;
                    })()}
                    {headline !== undefined ? (
                      <strong style={{ color: "var(--vendo-fg)", fontVariantNumeric: "tabular-nums" }}>
                        <Money cents={headline.totalCents} />
                      </strong>
                    ) : null}
                  </span>
                  {/* The disclosure sits OUTSIDE .fl-act-sub: that class truncates its
                      text with overflow:hidden + max-width:55%, which in a narrow host
                      column clipped this control out of its box entirely — rendered but
                      not hit-testable, so a real click landed on nothing and the row
                      never expanded. As a row-level flex item (flex-shrink:0) it stays
                      visible and clickable at any width; the text still ellipsises. */}
                  {hasDetail ? (
                    <button
                      type="button"
                      aria-expanded={opened}
                      aria-label={`${opened ? "Hide" : "Show"} details for the ${formatAuditTime(key)} firing`}
                      onClick={() => setOpen(current => ({ ...current, [key]: !(current[key] ?? false) }))}
                      style={{ border: "none", background: "none", color: "var(--vendo-fg-muted)", cursor: "pointer", flexShrink: 0, fontSize: 11, lineHeight: 1, padding: "0 2px" }}
                    >
                      {opened ? "▾" : "▸"}
                    </button>
                  ) : null}
                </div>
                {opened ? (
                  <div>
                    {firing.steps.map((step, index) => (
                      <RehearsalStepRow key={`${key}-${step.id}-${index}`} step={step} />
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );
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
  const [rehearsals, setRehearsals] = useState<Record<AppId, RehearsalReport | undefined>>({});
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
      setError(reason instanceof Error ? reason.message : String(reason));
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
      setError(`The permissions were denied, but switching the automation off failed (${
        reason instanceof Error ? reason.message : String(reason)
      }). It is still enabled — use its toggle to turn it off.`);
    }
  };

  // Evaluated once per render (not once per automation): matchMedia is cheap but
  // querying it inside the list map was needless repeated work.
  const reduced = theme.motion === "reduced"
    || (typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  return (
    <ChromeRoot>
      <section className="fl-auto-scroll" aria-labelledby="vendo-automations-heading" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="vendo-automations-heading" className="fl-auto-title" style={{ margin: 0 }}>Automations</h2>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        {automations.automations.length === 0 ? <p className="fl-auto-sub" style={{ margin: 0 }}>No automations yet.</p> : null}
        {automations.automations.map(entry => {
          const appId = entry.app.id;
          const appRuns = runs[appId];
          const flow = automationFlow(entry.app.trigger);
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
                    {runningRun ? (
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

              {flow ? (
                <div className="fl-auto-flow" aria-label={`Automation flow for ${entry.app.name}`}>
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

              {strip && strip.length > 0 ? (
                <div className="fl-auto-runs" aria-label={`Last ${strip.length} run${strip.length === 1 ? "" : "s"} for ${entry.app.name}: ${runRollup(strip)}`}>
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
                  disabled={busy[`rehearse-${appId}`]}
                  onClick={() => void during(`rehearse-${appId}`, async () => {
                    const report = await automations.rehearse(appId);
                    setRehearsals(current => ({ ...current, [appId]: report }));
                  })}
                >{busy[`rehearse-${appId}`] ? "Rehearsing…" : "Rehearse"}</button>
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
                  permissions={pendingAsks.map(ask => ({
                    approvalId: ask.id,
                    tool: ask.call.tool,
                    ...(ask.descriptor.description.length > 0 ? { description: ask.descriptor.description } : {}),
                    risk: ask.descriptor.risk,
                  }))}
                  state="parked"
                  onDecide={async approve => {
                    await decideSet(appId, pendingAsks, entry.grantSetId, approve);
                    if (approve) celebrateEnable(appId);
                  }}
                />
              ) : null}

              {rehearsals[appId] ? (
                <RehearsalTimeline
                  name={entry.app.name}
                  report={rehearsals[appId]!}
                  busy={busy[`rehearse-${appId}`] ?? false}
                  onWindowChange={windowDays => void during(`rehearse-${appId}`, async () => {
                    const report = await automations.rehearse(appId, windowDays);
                    setRehearsals(current => ({ ...current, [appId]: report }));
                  })}
                />
              ) : null}

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
