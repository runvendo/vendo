import {
  DEFAULT_TRIGGER_ID,
  serviceToolSlug,
  type ApprovalRequest,
  type AppId,
  type Trigger,
} from "@vendoai/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { APPROVALS_DECIDED_EVENT } from "../client-impl.js";
import { useVendoContext, useVendoTheme } from "../context.js";
import { useApprovals } from "../hooks/use-approvals.js";
import { useAutomations } from "../hooks/use-automations.js";
import type { RehearsalFiring, RehearsalOutlook, RehearsalReport, RehearsalStep, RunPlan, RunRecord, RunStatus } from "../wire-types.js";
import { formatAuditTime } from "./activity-semantics.js";
import { automationFlow, sponsorLabel, triggerLabel } from "./automation-card.js";
import { ChromeRoot } from "./chrome-root.js";
import { developmentMode } from "./dev-mode.js";
import { GrantSetCard, type GrantSetPermission } from "./grant-set-card.js";
import { humanizeToolName } from "./humanize.js";
import { Money } from "../kit/values.js";

const ENABLE_CELEBRATION_MS = 3_100;
const REDUCED_ENABLE_CELEBRATION_MS = 900;

/** How often an open panel re-reads the state it is showing. The same cadence
    WaitingQueue, VendoToasts and VendoActivities already ship, so a workspace
    with several of them open polls on one rhythm. */
const AUTOMATIONS_POLL_MS = 5_000;

/** ui-lane-panels pick B — the last-10-runs dot strip. */
const RUN_STRIP_LIMIT = 10;
const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  ok: "Succeeded",
  error: "Failed",
  running: "Running",
  stopped: "Stopped",
};
const RUN_STATUS_ROLLUP: Record<RunStatus, string> = {
  ok: "ok",
  error: "failed",
  running: "running",
  stopped: "stopped",
};

/** A run that stopped because it met a permission nobody had allowed. It is a
    FAILED run like any other — no waiting state exists — but it is the one
    failure the person can fix from here: allow what it needed, and run it
    again. */
const needsPermission = (run: RunRecord): boolean =>
  run.status === "error" && run.error?.code === "needs-permission";

/** The consent rows for a set of pending asks. One mapping for both cards the
    panel shows (arming, and the failed run's) so a permission reads the same in
    either place. A connector ask is FOR its service action, not for the
    dispatcher — two service actions are otherwise the same row twice. */
function grantSetPermissions(asks: readonly ApprovalRequest[]): GrantSetPermission[] {
  return asks.map(ask => {
    const slug = serviceToolSlug(ask.call);
    return {
      approvalId: ask.id,
      tool: ask.call.tool,
      ...(slug === undefined ? {} : { slug }),
      risk: ask.descriptor.risk,
    };
  });
}

/** "8 ok · 1 failed · 1 stopped" — text rollup so colour is never the only
    signal on the strip. Statuses appear in a fixed order, zero-counts drop. */
function runRollup(runs: RunRecord[]): string {
  const counts = new Map<RunStatus, number>();
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  const order: RunStatus[] = ["ok", "error", "running", "stopped"];
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

/** "Jul 18" — short day label for rehearsal windows and firing rows. */
function formatRehearsalDay(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  // Format in UTC: the server supplies ISO window bounds and the rest of the
  // timeline reads dates in UTC, so a local-timezone render here would drift the
  // displayed day off the actual pinned range by one for many viewers.
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Firings-box sizing. One collapsed firing row ≈ .fl-act-row (8+8px padding +
    line; measured ≈ 40px in the demo); REHEARSAL_BODY_PAD_PX is .fl-act-body's
    vertical padding. The box has no height cap and no internal scroll — a busy
    automation's full list renders in the page's normal flow, so the page-level
    .fl-auto-scroll scrollbar is the only one that ever appears. The estimate is
    used only as a minHeight high-water-mark so toggling 7d/30d for the same
    automation never visibly shrinks its own results box. */
const REHEARSAL_FIRING_ROW_PX = 40;
const REHEARSAL_BODY_PAD_PX = 6;

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
        // A missing grant is an APPROVAL request, not a hard block, so the
        // sub-line agrees with the "would ask first" label (not "blocked").
        // It stops short of promising execution, though: a standing grant does
        // not clear an unattended destructive call — THE LAW still refuses it —
        // so the copy states only that approval is the gate, not that it runs.
        ? `Would have asked for approval first — missing grant: ${grantList} (approval is required before it can run)`
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

/** Says what a rehearsal will be worth BEFORE it costs a round of real host
 *  reads. The acting-step count is the load-bearing half: a read-only
 *  automation replays fine and tells the user nothing they did not already
 *  know, which reads as the feature being thin rather than the automation
 *  being inert. The history half only qualifies how varied the timeline is. */
function rehearseHint(outlook: RehearsalOutlook | undefined): string | undefined {
  if (outlook === undefined) return undefined;
  if (outlook.actingSteps === 0) {
    return "Nothing to rehearse — this automation only reads, so there is no action to preview or approve.";
  }
  const actions = `${outlook.actingSteps} action${outlook.actingSteps === 1 ? "" : "s"} to preview`;
  if (outlook.readSteps === 0) return actions;
  return outlook.historicalReads === outlook.readSteps
    ? `${actions} · every firing replays its own window`
    : `${actions} · ${outlook.readSteps - outlook.historicalReads} of ${outlook.readSteps} reads answer with today's data, so those firings repeat`;
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
  // Every scheduled firing in the window, including the ones that skipped (all
  // `if`s false / a forEach matched nothing) — those still show as rows in the
  // timeline below, so the headline count must include them or it contradicts
  // what the reader sees.
  const firingCount = report.firings.length;
  const simulated = report.firings.reduce((count, firing) => count + firing.simulatedActions, 0);
  const newestFirst = report.firings.slice().reverse();
  // The firings box renders at its full natural height — no cap, no internal
  // scroll — so a busy automation's list is part of the page's normal flow and
  // the page-level .fl-auto-scroll scrollbar is the only one. bodyEstimate is a
  // minHeight high-water-mark that NEVER shrinks: the default 30d window (always
  // ≥ the 7d window's firing count) loads first and locks the larger floor, so
  // toggling 7d/30d for the same automation can't visibly shrink its own box.
  const bodyEstimate = report.firings.length * REHEARSAL_FIRING_ROW_PX + REHEARSAL_BODY_PAD_PX;
  const [bodyHeight, setBodyHeight] = useState(bodyEstimate);
  useEffect(() => {
    setBodyHeight(prev => Math.max(prev, bodyEstimate));
  }, [bodyEstimate]);
  return (
    <div
      className="fl-auto-flow"
      role="group"
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
          : `Would have fired ${firingCount} time${firingCount === 1 ? "" : "s"}`
            + (simulated > 0 ? ` · ${simulated} simulated action${simulated === 1 ? "" : "s"} — nothing was executed` : " · nothing was executed")
            + (report.truncated === true ? " · showing the most recent firings" : "")}
      </div>
      {/* minHeight (not height/maxHeight) high-water-marked so it never visibly
          shrinks on a 7d/30d toggle: the box holds its floor across toggles for
          the same automation, but content grows past it at its natural height
          with no internal scroll — a busy list simply extends the page and the
          single page-level scrollbar reaches it. */}
      {newestFirst.length > 0 ? (
        <div className="fl-act-body" style={{ minHeight: bodyHeight }}>
          {newestFirst.map(firing => {
            const key = firing.scheduledFor;
            const headline = firingHeadline(firing);
            const hasDetail = firing.steps.length > 0;
            const opened = hasDetail && (open[key] ?? false);
            return (
              <article key={key}>
                <div className="fl-act-row">
                  {/* `skipped` keeps the bare (inherited-color) icon: a green
                      tick beside a visible "skipped" verdict would contradict it. */}
                  <span
                    className={`fl-act-ic ${firing.status === "fired" ? "fl-act-tick" : firing.status === "error" ? "fl-act-x" : ""}`}
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
                      // "would stop", not "would ask": this count folds in
                      // policy-BLOCKED actions (which never run) alongside
                      // would-ask ones, so labelling it "would ask" would present
                      // a rule that will never fire as an approval request.
                      return wouldStop > 0 ? (
                        <span className="fl-act-x" style={{ fontWeight: 600 }}>· {wouldStop} would stop</span>
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

/** The identity of a panel ROW: one trigger of one app. An automation is an app
    with a LIST of triggers, so nothing in this panel is keyed by app alone. */
const rowKey = (appId: AppId, triggerId: string): string => `${appId}:${triggerId}`;

/** The host's theme setting, or the OS's — one spelling for both the celebration's
    duration and the animations it gates. */
const prefersReducedMotion = (motion: "full" | "reduced"): boolean =>
  motion === "reduced"
  || (typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

export interface AutomationsPanelProps {
  /** Re-read cadence for the state this panel shows, in ms. 0 turns the poll
      off (a host driving refreshes itself, or a test). */
  pollMs?: number;
}

/** 08-ui §4; 07-automations §5 — controls, grant capture, previews, history, kill switch.
    The trigger/flow labels (triggerLabel, automationFlow) moved to
    automation-card.tsx (2026-07 demo feedback), shared with the read-only
    in-thread AutomationCard. */
export function AutomationsPanel({ pollMs = AUTOMATIONS_POLL_MS }: AutomationsPanelProps = {}) {
  // An automation is the one surface where everything interesting happens while
  // NOBODY is looking at it: it fires away, on a schedule. A panel that read the
  // wire once and then only ticked a clock could never show that — a run that
  // started after the fetch was never seen "running", so its Stop button never
  // rendered and the kill switch was unreachable, and a run that finished left
  // the history reading "No runs yet" until someone reloaded the page.
  const poll = pollMs > 0 ? { pollMs } : undefined;
  const automations = useAutomations(poll);
  const approvals = useApprovals(poll);
  const { client } = useVendoContext();
  const theme = useVendoTheme();
  // Every per-row map below is keyed by ROW — `${appId}:${triggerId}` — because
  // an app has a list of triggers and each one is dry-run, rehearsed, inspected,
  // armed and celebrated on its own. Keying any of these by app alone would make
  // two triggers of one app share a run strip, a plan, a rehearsal and a busy flag.
  const [plans, setPlans] = useState<Record<string, RunPlan | undefined>>({});
  const [rehearsals, setRehearsals] = useState<Record<string, RehearsalReport | undefined>>({});
  const [runs, setRuns] = useState<Record<string, RunRecord[] | undefined>>({});
  const [recent, setRecent] = useState<Record<string, RunRecord[] | undefined>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string>();
  const [justEnabled, setJustEnabled] = useState<Record<string, boolean>>({});
  const enableTimers = useRef(new Map<string, number>());
  const stripFetched = useRef(new Set<string>());
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
      for (const { trigger } of entry.triggers) {
        const key = rowKey(appId, trigger.id);
        if (stripFetched.current.has(key)) continue;
        stripFetched.current.add(key);
        void (async () => {
          try {
            const result = await listRuns({ appId, triggerId: trigger.id });
            // A discarded (cancelled) response must also unmark the row, or an
            // effect restart would skip its only retry and the strip never renders.
            if (cancelled) {
              stripFetched.current.delete(key);
              return;
            }
            setRecent(current => ({ ...current, [key]: result.runs.slice(0, RUN_STRIP_LIMIT) }));
          } catch {
            if (!cancelled) stripFetched.current.delete(key);
          }
        })();
      }
    }
    return () => {
      cancelled = true;
    };
  }, [automations.automations, listRuns]);

  // The row states above ride the hooks' own poll; RUNS are fetched per row, so
  // they get the same cadence here. Both copies are refreshed together — the
  // strip (which decides whether the row says "running now") and, only where the
  // person has it open, the expanded history (which carries the Stop button) —
  // because a run that is live in one and finished in the other is exactly the
  // disagreement this panel used to show. Same ref trick as the decision
  // listener below: the sweep reads the CURRENT rows while its interval stays
  // mount-stable.
  const sweepRunsRef = useRef<() => void>(() => undefined);
  sweepRunsRef.current = () => {
    for (const entry of automations.automations) {
      const appId = entry.app.id;
      for (const { trigger } of entry.triggers) {
        const key = rowKey(appId, trigger.id);
        const open = runs[key] !== undefined;
        void (async () => {
          try {
            const result = await listRuns({ appId, triggerId: trigger.id });
            setRecent(current => ({ ...current, [key]: result.runs.slice(0, RUN_STRIP_LIMIT) }));
            // Never REOPEN a history the person collapsed while this was in
            // flight — `undefined` is what "collapsed" means to the row below.
            if (open) {
              setRuns(current => current[key] === undefined ? current : { ...current, [key]: result.runs });
            }
          } catch {
            // A poll that misses changes nothing: the rows keep their last good
            // answer and the next tick tries again. Same silence the first strip
            // fetch keeps, and deliberately NOT the shared alert — a background
            // refresh must not put an error in front of someone who did nothing.
          }
        })();
      }
    }
  };
  useEffect(() => {
    if (pollMs <= 0) return;
    const timer = window.setInterval(() => {
      // A tab nobody is looking at costs the deployment nothing — the same rule
      // the shared approvals feed follows.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      sweepRunsRef.current();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs]);

  const clearEnableCelebration = (key: string) => {
    const timer = enableTimers.current.get(key);
    if (timer !== undefined) window.clearTimeout(timer);
    enableTimers.current.delete(key);
    setJustEnabled(current => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const celebrateEnable = (key: string) => {
    const existing = enableTimers.current.get(key);
    if (existing !== undefined) window.clearTimeout(existing);
    setJustEnabled(current => ({ ...current, [key]: true }));
    enableTimers.current.set(key, window.setTimeout(
      () => clearEnableCelebration(key),
      prefersReducedMotion(theme.motion) ? REDUCED_ENABLE_CELEBRATION_MS : ENABLE_CELEBRATION_MS,
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

  /** The kill switch, from either place it is offered: the TRIGGER ROW (where a
      live run is actually being watched) and the run's own history row. One
      action, one busy key, so the two copies of the button can never disagree
      about whether a stop is in flight.

      Both stores of the row's runs settle here, because the row reads the
      expanded history when it is open and the last-10 strip otherwise — settling
      only one would leave the row still claiming a run it just killed. */
  const stopRun = (key: string, runId: RunRecord["id"]) =>
    during(`stop-${runId}`, async () => {
      await automations.stopRun(runId);
      const settled = (list: RunRecord[] | undefined): RunRecord[] =>
        (list ?? []).map(item => item.id === runId ? { ...item, status: "stopped" } : item);
      // Never REOPEN a history the person collapsed — `undefined` is what
      // "collapsed" means to the row, so a stop from the trigger row above must
      // not conjure an empty one ("No runs yet." under a row that has runs).
      setRuns(current => current[key] === undefined ? current : { ...current, [key]: settled(current[key]) });
      setRecent(current => ({ ...current, [key]: settled(current[key]) }));
    });

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
  const decideSet = async (
    appId: AppId,
    triggerId: string,
    asks: ApprovalRequest[],
    grantSetId: string | undefined,
    approve: boolean,
  ) => {
    await approvals.decide(
      asks.map(ask => ask.id),
      { approve },
      grantSetId === undefined ? undefined : { grantSetId },
    );
    await automations.refresh();
    if (approve) return;
    const [entries, grants] = await Promise.all([client.automations.list(), client.grants.list()]);
    const row = entries
      .find(candidate => candidate.app.id === appId)
      ?.triggers.find(candidate => candidate.trigger.id === triggerId);
    const stillArmed = row !== undefined && row.enabled && (row.pendingGrants ?? 0) === 0;
    // The engine keeps a PARTIALLY granted automation armed by design (its
    // ungranted steps park at fire time) — repair only a consent moment that
    // granted nothing yet left the row enabled. Scoped to the TRIGGER: a
    // sibling trigger's grants are not evidence about this one.
    const grantedSomething = grants.some(grant =>
      grant.appId === appId
      && (grant.triggerId ?? DEFAULT_TRIGGER_ID) === triggerId
      && grant.source === "automation"
      && grant.duration === "standing"
      && grant.revokedAt === undefined);
    if (!stillArmed || grantedSomething) return;
    try {
      await automations.disable(appId, triggerId);
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

  /** The pending asks for exactly what a failed run needed — matched on the
      THING being allowed (the tool, or the connector's service action), because
      that is what the run names and what a grant is scoped to.
      One row per thing: the same permission can be outstanding twice (an arming
      ask nobody answered, plus the one the guard raised when the run met it),
      and a person is being asked ONE question. The OLDEST is the one to settle —
      it is the ask the engine is projecting as outstanding, so answering it is
      what clears "waiting on 1 permission"; the duplicate expires unanswered. */
  const asksForRun = (appId: AppId, run: RunRecord): ApprovalRequest[] => {
    const wanted = run.error;
    if (wanted === undefined) return [];
    return (pendingByApp.get(appId) ?? [])
      .filter(ask => ask.call.tool === wanted.tool && serviceToolSlug(ask.call) === wanted.slug)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, 1);
  };

  /** Grant & re-run — allow what the run needed, then run the automation again
      (a fresh run on the same event; nothing is resumed). Deny settles the ask
      and runs nothing. */
  const grantAndRerun = async (
    appId: AppId,
    triggerId: string,
    key: string,
    run: RunRecord,
    asks: ApprovalRequest[],
    grantSetId: string | undefined,
    approve: boolean,
  ) => {
    await decideSet(appId, triggerId, asks, grantSetId, approve);
    if (!approve) return;
    await automations.rerun(run.id);
    // The history the person is looking at must show the new attempt, not the
    // list from before they tapped.
    const result = await automations.runs({ appId, triggerId });
    setRuns(current => ({ ...current, [key]: result.runs }));
  };

  // Evaluated once per render (not once per automation): matchMedia is cheap but
  // querying it inside the list map was needless repeated work.
  const reduced = prefersReducedMotion(theme.motion);

  return (
    <ChromeRoot>
      <section className="fl-auto-scroll" aria-labelledby="vendo-automations-heading" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="vendo-automations-heading" className="fl-auto-title" style={{ margin: 0 }}>Automations</h2>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        {automations.automations.length === 0 ? <p className="fl-auto-sub" style={{ margin: 0 }}>No automations yet.</p> : null}
        {automations.automations.map(entry => {
          const appId = entry.app.id;
          // WHICH row shows the app's pending set card. The persisted queue names
          // the APP, not the trigger, so the trigger the engine says is waiting
          // owns them, and when nothing claims them the FIRST row does. That
          // fallback is not a nicety — a payload from before `pendingGrants`
          // existed carries no claim at all, and a card nobody renders is a person
          // left holding an approval the automation never hears the answer to.
          // With one trigger (the ordinary case) both branches are the same row.
          const claimantId = (entry.triggers.find(candidate => (candidate.pendingGrants ?? 0) > 0)
            ?? entry.triggers[0])?.trigger.id;
          return (
            <article className="fl-automation" key={appId}>
              {/* The app is the GROUP header: it names the thing, and its
                  triggers are the rows that get switched on and off. It carries
                  no toggle of its own — an app is not a switch, its triggers
                  are. */}
              <div className="fl-auto-head">
                <span className="fl-auto-ic" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m13 2-9 12h8l-1 8 9-12h-8l1-8Z" />
                  </svg>
                </span>
                <div>
                  <div className="fl-auto-title">{entry.app.name}</div>
                  {entry.triggers.length > 1 ? (
                    <div className="fl-auto-sub">{entry.triggers.length} triggers</div>
                  ) : null}
                </div>
              </div>

              {entry.triggers.map(row => {
                const trigger = row.trigger;
                const key = rowKey(appId, trigger.id);
                const label = triggerLabel(trigger);
                const rowRuns = runs[key];
                const plan = plans[key];
                const flow = automationFlow(trigger);
                const runsAs = sponsorLabel(row.sponsor, entry.editors);
                // The set-card rows come from the persisted pending queue; the
                // count prefers the engine's own projection (they agree modulo
                // poll skew).
                const pendingAsks = claimantId === trigger.id
                  ? pendingByApp.get(appId) ?? []
                  : [];
                const waitingOn = row.pendingGrants ?? pendingAsks.length;
                // ONE question, ONE card. A failed run in the open history shows
                // the ask that stopped it — with the re-run action, which is the
                // whole reason to answer it there — so the arming card above must
                // not ask the same thing a second time. Collapse the history and
                // it comes back: the person is never left with a card nobody
                // renders.
                const claimedByRuns = new Set(
                  (rowRuns ?? [])
                    .filter(needsPermission)
                    .flatMap(run => asksForRun(appId, run).map(ask => ask.id)),
                );
                const armingAsks = claimedByRuns.size === 0
                  ? pendingAsks
                  : pendingAsks.filter(ask => !claimedByRuns.has(ask.id));
                const celebrating = justEnabled[key] === true;
                // Oldest → newest left-to-right, so the strip reads like a timeline.
                const strip = recent[key]?.slice().reverse();
                // 7-A liveness — a running run puts the traveling dot on the arrow
                // and takes over the state line; otherwise the enabled line carries
                // the next-run countdown when it can be computed honestly. The
                // expanded history is fresher than the strip when both exist.
                const known = rowRuns ?? recent[key];
                const runningRun = known?.find(run => run.status === "running");
                // "step N/M": M = the plan's step count, N = the step in flight
                // (recorded steps + 1). Plans without steps just say "running now".
                const plannedSteps = trigger.run.kind === "steps" ? trigger.run.steps.length : 0;
                const runningStep = runningRun && plannedSteps > 0
                  ? ` · step ${Math.min(runningRun.steps.length + 1, plannedSteps)}/${plannedSteps}`
                  : "";
                // Latest start by value, not position — storage pages are not
                // guaranteed newest-first (ISO instants compare lexically).
                const lastStartedAt = known?.reduce<string | undefined>(
                  (latest, run) => (!latest || run.startedAt > latest ? run.startedAt : latest),
                  undefined,
                );
                const nextRun = row.enabled && !runningRun
                  ? nextRunLabel(trigger, lastStartedAt, now)
                  : null;
                // Every row after the first sits under the same hairline the
                // flow block already uses, so a multi-trigger app reads as one
                // card with rows rather than several cards jammed together.
                return (
                  <section
                    key={key}
                    aria-label={`${entry.app.name} — ${label.title}`}
                    style={celebrating && !reduced
                      ? { animation: "fl-connect-bloom .5s cubic-bezier(.22,1,.36,1) both" }
                      : undefined}
                  >
                    <div
                      className="fl-auto-head"
                      style={{
                        borderTop: "1px solid var(--vendo-border)",
                        // Aligns the trigger's title under the app's, past the
                        // app icon: the icon's 34px plus the head's 12px gap.
                        paddingLeft: 34 + 12 + 16,
                      }}
                    >
                      <div>
                        {/* Deliberately the NODE type scale, not the title one:
                            the app name above is the group's heading and has to
                            keep primacy over its rows. */}
                        <span className="fl-auto-node-t">{label.title}</span>
                        <div className="fl-auto-sub">
                          {/* §9.9 — `stopped` is the SERVER's word on the automation
                              itself and it outranks any run row: the fire-time check
                              stops a run before its first tool call, so a run left
                              looking live cannot be allowed to report "running now"
                              about something that will not run again until it is
                              taken on. */}
                          {row.stopped !== undefined ? (
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
                              {row.enabled ? (
                                <span
                                  className={`fl-auto-live${waitingOn > 0 ? " fl-auto-wait" : ""}`}
                                  aria-hidden="true"
                                  style={celebrating && !reduced
                                    ? { animation: "fl-connect-pop .55s cubic-bezier(.22,1,.36,1) both" }
                                    : undefined}
                                />
                              ) : null}
                              {row.enabled
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
                        {row.stopped === undefined ? null : (
                          <div className="fl-auto-sub fl-auto-stopped" style={{ display: "block" }} role="status">
                            {row.stopped.summary}
                          </div>
                        )}
                        {/* §13 — an automation always runs as a named person, and its
                            window says so. Per trigger, because each one is sponsored
                            on its own. */}
                        {runsAs === null
                          ? null
                          : <div className="fl-auto-sub" style={{ display: "block" }}>{runsAs}</div>}
                      </div>
                      {/* The kill switch belongs where the run is being WATCHED.
                          It used to exist only inside the expanded Run history,
                          so the person reading "running now" on this row had to
                          guess that a collapsed panel held the one button that
                          could stop it. The history keeps its own copy — this is
                          the same action, not a replacement. */}
                      {runningRun ? (
                        <button
                          className="fl-btn fl-btn-ceremony"
                          type="button"
                          // Named for its TRIGGER, exactly as the toggle beside it
                          // is and for the same reason: the history row's Stop is
                          // a second control saying the same word on the same
                          // page, and two controls nobody can tell apart is what
                          // this name exists to prevent.
                          aria-label={`Stop ${entry.app.name} — ${label.title}`}
                          disabled={busy[`stop-${runningRun.id}`]}
                          // The toggle holds the row's right edge with its own
                          // `margin-left: auto`; the Stop takes that space over so
                          // the pair sits together and the toggle — the row's
                          // permanent control — never moves when a run starts.
                          style={{ marginLeft: "auto" }}
                          onClick={() => void stopRun(key, runningRun.id)}
                        >Stop</button>
                      ) : null}
                      <button
                        className="fl-auto-toggle"
                        type="button"
                        role="switch"
                        // Name identifies WHICH TRIGGER of which app (aria-checked
                        // carries the on/off state) so screen readers and role/name
                        // tests can tell two same-state toggles apart and never flip
                        // the wrong one. Two triggers of one app is exactly the case
                        // that makes the app name alone ambiguous.
                        aria-label={`Enable ${entry.app.name} — ${label.title}`}
                        aria-checked={row.enabled}
                        disabled={busy[`toggle-${key}`]}
                        style={{
                          // OFF has to be VISIBLE as a state (WCAG 1.4.11): the 14%
                          // hairline track sat at ~1.4:1, so "off" read as "no
                          // control here". --vendo-indicator is the 3:1 derivation.
                          background: row.enabled ? "var(--vendo-accent)" : "var(--vendo-indicator)",
                          // The Stop above takes the auto margin when it is there.
                          ...(runningRun ? { marginLeft: 0 } : {}),
                          transform: row.enabled ? undefined : "rotate(180deg)",
                          transition: "background .2s ease, transform .2s cubic-bezier(.22,1,.36,1)",
                        }}
                        onClick={() => void during(`toggle-${key}`, async () => {
                          if (row.enabled) {
                            await automations.disable(appId, trigger.id);
                            clearEnableCelebration(key);
                          } else {
                            const result = await automations.enable(appId, trigger.id);
                            // The minted asks land in the persisted pending queue;
                            // re-fetch it so the grant-set card renders from the
                            // same source a reload would use.
                            await approvals.refresh();
                            if (result.enabled && result.missing.length === 0) celebrateEnable(key);
                          }
                        })}
                      />
                    </div>

                    {/* role="group": a bare <div> may not carry aria-label (axe
                        aria-prohibited-attr) — and this IS a group, the two labelled
                        nodes of one trigger→action flow. */}
                    {flow ? (
                      <div className="fl-auto-flow" role="group" aria-label={`Automation flow for ${entry.app.name} — ${label.title}`}>
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
                      <div className="fl-auto-runs" role="img" aria-label={`Last ${strip.length} run${strip.length === 1 ? "" : "s"} for ${entry.app.name} — ${label.title}: ${runRollup(strip)}`}>
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
                          <div className="fl-auto-created-sub">{label.title} enabled</div>
                        </div>
                      </div>
                    ) : null}

                    <div className="fl-auto-flow" style={{ gap: 8 }}>
                      <button className="fl-btn" type="button" onClick={() => void during(`plan-${key}`, async () => {
                        const plan = await automations.dryRun(appId, trigger.id);
                        setPlans(current => ({ ...current, [key]: plan }));
                      })}>Dry run</button>
                      {/* The outlook is resolved server-side with rehearse()'s own
                          predicates, per TRIGGER — rehearsal replays one trigger's
                          schedule. Unsupported shapes (agentic runs, non-schedule
                          triggers, armed triggers, empty windows) drop the control
                          entirely rather than offering an action that only errors.
                          No acting step DISABLES it: the replay would spend a full
                          round of real host reads to report that there is nothing
                          to consent to, and a control that looks spent-but-clickable
                          invites exactly that. The title says why, on the wrapper —
                          a disabled button does not surface its own tooltip. Absent
                          outlook (older server) = unknown, so offer it exactly as
                          before. */}
                      {row.rehearsal === undefined || row.rehearsal.supported ? (
                        <span
                          title={rehearseHint(row.rehearsal)}
                          className={row.rehearsal?.actingSteps === 0 ? "fl-btn-wrap-disabled" : undefined}
                          style={{ display: "inline-flex" }}
                        >
                          <button
                            className="fl-btn"
                            type="button"
                            disabled={busy[`rehearse-${key}`] || row.rehearsal?.actingSteps === 0}
                            onClick={() => void during(`rehearse-${key}`, async () => {
                              const report = await automations.rehearse(appId, trigger.id);
                              setRehearsals(current => ({ ...current, [key]: report }));
                            })}
                          >{busy[`rehearse-${key}`] ? "Rehearsing…" : "Rehearse"}</button>
                        </span>
                      ) : null}
                      <button
                        className="fl-btn"
                        type="button"
                        aria-expanded={rowRuns !== undefined}
                        onClick={() => void during(`runs-${key}`, async () => {
                          if (rowRuns !== undefined) {
                            setRuns(current => ({ ...current, [key]: undefined }));
                          } else {
                            const result = await automations.runs({ appId, triggerId: trigger.id });
                            setRuns(current => ({ ...current, [key]: result.runs }));
                          }
                        })}
                      >Run history</button>
                    </div>

                    {armingAsks.length > 0 ? (
                      <GrantSetCard
                        name={entry.app.name}
                        permissions={grantSetPermissions(armingAsks)}
                        state="parked"
                        onDecide={async approve => {
                          await decideSet(appId, trigger.id, armingAsks, row.grantSetId, approve);
                          if (approve) celebrateEnable(key);
                        }}
                      />
                    ) : null}

                    {rehearsals[key] ? (
                      <RehearsalTimeline
                        name={entry.app.name}
                        report={rehearsals[key]!}
                        busy={busy[`rehearse-${key}`] ?? false}
                        onWindowChange={windowDays => void during(`rehearse-${key}`, async () => {
                          const report = await automations.rehearse(appId, trigger.id, windowDays);
                          setRehearsals(current => ({ ...current, [key]: report }));
                        })}
                      />
                    ) : null}

                    {plan ? (
                      <div
                        className="fl-auto-flow"
                        // role="group": a bare <div> may not carry aria-label
                        // (aria-prohibited-attr) — same fix as the flow block above.
                        role="group"
                        aria-label={`Dry run for ${entry.app.name} — ${label.title}`}
                        style={{ alignItems: "stretch", flexDirection: "column", gap: 10 }}
                      >
                        <strong className="fl-auto-title">Dry-run plan</strong>
                        <ol style={{ alignItems: "stretch", display: "flex", listStyle: "none", margin: 0, padding: 0 }}>
                          {plan.steps.map((step, index) => (
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
                        <div className="fl-auto-sub">Missing grants: {plan.grantsMissing.length ? plan.grantsMissing.join(", ") : "none"}</div>
                      </div>
                    ) : null}

                    {rowRuns !== undefined ? (
                      <div className="fl-act-body" role="group" aria-label={`Run history for ${entry.app.name} — ${label.title}`}>
                        {rowRuns.length === 0 ? <p className="fl-act-row">No runs yet.</p> : rowRuns.map(run => {
                          // The asks this run is waiting on someone to allow —
                          // and therefore whether it can be re-run from here.
                          const runAsks = needsPermission(run) ? asksForRun(appId, run) : [];
                          return (
                          <article key={run.id}>
                            <div className="fl-act-row">
                              <span className={`fl-act-ic ${run.status === "error" ? "fl-act-x" : "fl-act-tick"}`} aria-hidden="true">
                                {run.status === "error" ? "✕" : "✓"}
                              </span>
                              <strong className="fl-act-lbl">{RUN_STATUS_LABEL[run.status]}</strong>
                              <time className="fl-act-sub" dateTime={run.startedAt}>{formatAuditTime(run.startedAt)}</time>
                              {run.status === "running" ? (
                                <button
                                  className="fl-btn fl-btn-ceremony"
                                  type="button"
                                  disabled={busy[`stop-${run.id}`]}
                                  onClick={() => void stopRun(key, run.id)}
                                >Stop</button>
                              ) : null}
                              {runAsks.length > 0 ? (
                                <button
                                  className="fl-btn fl-btn-primary"
                                  type="button"
                                  disabled={busy[`rerun-${run.id}`]}
                                  onClick={() => void during(`rerun-${run.id}`, () =>
                                    grantAndRerun(appId, trigger.id, key, run, runAsks, row.grantSetId, true))}
                                >Grant &amp; re-run</button>
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
                                {/* A run that stopped for a missing permission
                                    needs no sentence of ours: its own summary
                                    already says what it needed and what to do,
                                    and the card below is the doing. The generic
                                    line would also be WRONG here twice over — the
                                    steps before the miss really did run, and once
                                    the permission is allowed a "hasn't been
                                    allowed" line becomes a stale claim on a row
                                    that never changes. */}
                                {needsPermission(run) ? null : (
                                  <p role="alert" className="fl-error">
                                    {`This run didn’t finish — nothing in your account was changed.`}
                                  </p>
                                )}
                                {developmentMode()
                                  ? <p className="fl-act-sub">{`${run.error.code}: ${run.error.message}`}</p>
                                  : null}
                              </>
                            ) : null}
                            {/* The consent card the person answers, right where
                                the failure is: the SAME card the arming ceremony
                                uses, so one permission reads one way everywhere.
                                Allowing it re-runs the automation. */}
                            {runAsks.length > 0 ? (
                              <GrantSetCard
                                name={entry.app.name}
                                permissions={grantSetPermissions(runAsks)}
                                state="parked"
                                onDecide={approve =>
                                  grantAndRerun(appId, trigger.id, key, run, runAsks, row.grantSetId, approve)}
                              />
                            ) : null}
                          </article>
                          );
                        })}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </article>
          );
        })}
      </section>
    </ChromeRoot>
  );
}
