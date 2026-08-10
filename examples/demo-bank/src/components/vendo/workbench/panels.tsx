"use client";

import clsx from "clsx";
import { useState } from "react";
import type { WorkbenchPart } from "@vendoai/ui";
import { Chevron, Chip, Disclosure, Empty, SectionHead } from "./parts";
import { count, describe, duration, eventsOf, rows, share, TONES, type Tone } from "./model";
import styles from "./workbench.module.css";

type PanelProps = { parts: readonly WorkbenchPart[] };

const GUARD_TONE: Record<string, Tone> = { run: "ok", ask: "warn", block: "bad" };
const STATUS_TONE: Record<string, Tone> = { ok: "mute", denied: "bad", error: "bad" };
const APPROVAL_TONE: Record<string, Tone> = { auto: "mute", approved: "ok", "timed-out": "bad", denied: "bad" };

/** Which agent spoke — only worth saying when it is not the turn's own. */
function AgentTag({ agent }: { agent: WorkbenchPart["agent"] }) {
  if (agent === "resident") return null;
  return <Chip tone={agent === "screen" ? "info" : "sys"}>{agent}</Chip>;
}

/* ------------------------------------------------------------- timeline */

export function TimelinePanel({ parts }: PanelProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen(current => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const list = rows(parts);
  if (list.length === 0) {
    return <Empty title="Nothing on the wire yet" detail="Diagnostics appear here the moment a turn starts." />;
  }
  return (
    <div>
      {list.map((row, index) => {
        if (row.kind === "event") {
          const { part } = row;
          const body = part.event.kind === "compaction" ? part.event.summary
            : part.event.kind === "subagent" ? part.event.report
            : undefined;
          const id = `event:${index}`;
          const isOpen = open.has(id);
          const tone = TONES[part.event.kind];
          const head = (
            <>
              {body === undefined ? <span style={{ width: 9, flex: "none" }} /> : <Chevron open={isOpen} />}
              <Chip tone={tone}>{part.event.kind}</Chip>
              {/* Never say "subagent" twice — the kind chip already said it. */}
              {part.event.kind === part.agent ? null : <AgentTag agent={part.agent} />}
              <span className={styles.evtText}>{describe(part.event)}</span>
            </>
          );
          return (
            <div className={styles.node} key={id}>
              <div className={styles.railCol}>
                <span
                  className={clsx(
                    styles.mark,
                    tone === "sys" && styles.markSys,
                    tone === "bad" && styles.markBad,
                    tone === "warn" && styles.markWarn,
                    tone === "info" && styles.markInfo,
                  )}
                />
              </div>
              <div>
                {body === undefined
                  ? <div className={styles.evt}>{head}</div>
                  : (
                    <Disclosure open={isOpen} onToggle={() => toggle(id)} className={styles.evt} head={head}>
                      <pre className={styles.summary}>{body}</pre>
                    </Disclosure>
                  )}
              </div>
            </div>
          );
        }

        const id = `step:${row.step}`;
        const isOpen = open.has(id);
        const start = row.parts.find(part => part.event.kind === "step-start");
        const end = row.parts.find(part => part.event.kind === "step-end");
        const calls = eventsOf(row.parts, "tool");
        const usage = end?.event.kind === "step-end" ? end.event.usage : undefined;
        const live = end === undefined;
        return (
          <div className={styles.node} key={id}>
            <div className={styles.railCol}>
              <span className={clsx(styles.num, live && styles.numLive)}>
                {String(row.step).padStart(2, "0")}
              </span>
            </div>
            <div>
              <Disclosure
                open={isOpen}
                onToggle={() => toggle(id)}
                className={styles.stepBtn}
                head={(
                  <>
                    <Chevron open={isOpen} />
                    <span className={styles.stepSum}>
                      <span className={styles.stepName}>{calls[0]?.event.name ?? "no tool calls"}</span>
                      {calls.length > 1 ? <span className={styles.stepExtra}>+{calls.length - 1} more</span> : null}
                    </span>
                    <span className={styles.stepMeta}>
                      {usage === undefined ? null : (
                        <span className={styles.tok}>
                          {count(usage.inputTokens ?? 0)} in · {count(usage.outputTokens ?? 0)} out
                        </span>
                      )}
                      {end?.event.kind === "step-end"
                        ? <span className={styles.dur}>{duration(end.event.durationMs)}</span>
                        : null}
                      <Chip tone={live ? "info" : "mute"}>
                        {end?.event.kind === "step-end" ? end.event.stopReason : "in flight"}
                      </Chip>
                    </span>
                  </>
                )}
              >
                <div className={styles.expPad}>
                  {calls.map(call => (
                    <div className={styles.call} key={call.event.toolCallId}>
                      <span className={styles.callName}>{call.event.name}</span>
                      <span className={styles.callArgs}>{call.event.argsPreview}</span>
                      <span className={styles.callRight}>
                        <AgentTag agent={call.agent} />
                        {call.event.guard === undefined
                          ? null
                          : <Chip tone={GUARD_TONE[call.event.guard] ?? "mute"}>{call.event.guard}</Chip>}
                        {/* The approval only earns a chip when it says something
                            the status does not — "denied · denied" is one fact. */}
                        {call.event.approval === undefined || call.event.approval === "auto"
                          || call.event.approval === call.event.status
                          ? null
                          : <Chip tone={APPROVAL_TONE[call.event.approval] ?? "mute"}>{call.event.approval}</Chip>}
                        <Chip tone={STATUS_TONE[call.event.status] ?? "mute"}>{call.event.status}</Chip>
                        <span className={styles.dur}>{duration(call.event.durationMs)}</span>
                      </span>
                    </div>
                  ))}
                  <div className={styles.mini}>
                    {start?.event.kind === "step-start" ? (
                      <div className={styles.miniRow}>
                        <Chip tone="mute">loadout</Chip>
                        <span>
                          {start.event.activeTools.length} {start.event.activeTools.length === 1 ? "tool" : "tools"}
                          {" active · step cap "}{start.event.maxSteps}
                        </span>
                      </div>
                    ) : null}
                    {calls.length === 0
                      ? <div className={clsx(styles.miniRow, styles.miniFaint)}>no tool calls in this step</div>
                      : null}
                  </div>
                </div>
              </Disclosure>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- context */

export function ContextPanel({ parts }: PanelProps) {
  const [open, setOpen] = useState<number | undefined>(undefined);
  const readings = eventsOf(parts, "context");
  const latest = readings.at(-1)?.event;
  const compactions = eventsOf(parts, "compaction");
  const sheds = eventsOf(parts, "shed");
  const pct = latest === undefined ? 0 : share(latest.estTokens, latest.windowTokens);
  const triggerPct = latest === undefined ? 0 : share(latest.triggerTokens, latest.windowTokens);
  return (
    <div>
      {latest === undefined ? (
        <div className={styles.sec}>
          <Empty title="No context readings this turn" detail="The harness reports the window as it fills." />
        </div>
      ) : (
        <div className={styles.gaugeCard}>
          <div className={styles.gaugeTop}>
            <span className={styles.big}>{count(latest.estTokens)}</span>
            <span className={styles.of}>/ {count(latest.windowTokens)} tok</span>
            <Chip tone={pct >= triggerPct ? "warn" : "info"}>{pct}%</Chip>
            <span className={styles.gaugeLab}>est. prompt tokens</span>
          </div>
          <div className={styles.gauge}>
            <span className={styles.gaugeFill} style={{ width: `${pct}%` }} />
            <span className={styles.gaugeTrigger} style={{ left: `${triggerPct}%` }} />
          </div>
          <div className={styles.gaugeLegend}>
            {triggerPct > 50 ? (
              <span className={styles.gaugeMark} style={{ right: `${100 - triggerPct}%` }}>
                compaction trigger · {triggerPct}% · {count(latest.triggerTokens)} ▲
              </span>
            ) : (
              <span className={styles.gaugeMark} style={{ left: `${triggerPct}%` }}>
                ▲ compaction trigger · {triggerPct}% · {count(latest.triggerTokens)}
              </span>
            )}
          </div>
        </div>
      )}

      {readings.length > 1 ? (
        <div className={styles.sec}>
          <SectionHead label="readings" count={readings.length} />
          <table className={styles.t}>
            <tbody>
              {readings.map(reading => (
                <tr key={reading.seq}>
                  <td className={clsx(styles.tKey, styles.mono)} style={{ width: 64 }}>#{reading.seq}</td>
                  <td className={styles.mono}>{count(reading.event.estTokens)} tok</td>
                  <td className={clsx(styles.r, styles.mono)}>
                    {share(reading.event.estTokens, reading.event.windowTokens)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className={styles.sec}>
        <SectionHead label="compaction history" count={compactions.length} />
        {compactions.length === 0 ? (
          <Empty
            title="No compaction this turn"
            detail={latest === undefined
              ? "Nothing was folded — the harness reported no window pressure."
              : `The prompt sat at ${pct}% — the ${triggerPct}% trigger was never reached.`}
          />
        ) : compactions.map(part => (
          <div className={styles.cmp} key={part.seq}>
            <Disclosure
              open={open === part.seq}
              onToggle={() => setOpen(current => (current === part.seq ? undefined : part.seq))}
              className={styles.cmpBtn}
              head={(
                <>
                  <Chevron open={open === part.seq} />
                  <span className={styles.cmpWhen}>#{part.seq}</span>
                  <span className={styles.cmpWhat}>{describe(part.event)}</span>
                  <Chip tone="sys">{part.event.reason}</Chip>
                </>
              )}
            >
              <pre className={styles.summary}>{part.event.summary}</pre>
            </Disclosure>
          </div>
        ))}
      </div>

      <div className={styles.sec}>
        <SectionHead label="shed events" count={sheds.length} />
        {sheds.length === 0
          ? <Empty title="Nothing shed" detail="No provider call overflowed this turn." />
          : (
            <table className={styles.t}>
              <tbody>
                {sheds.map(part => (
                  <tr key={part.seq}>
                    <td className={clsx(styles.tKey, styles.mono)} style={{ width: 64 }}>#{part.seq}</td>
                    <td>{describe(part.event)}</td>
                    <td className={clsx(styles.r, styles.mono)}>−{part.event.dropped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- tools */

export function ToolsPanel({ parts }: PanelProps) {
  const loadout = eventsOf(parts, "loadout").at(-1)?.event;
  const subagents = eventsOf(parts, "subagent");
  if (loadout === undefined && subagents.length === 0) {
    return <Empty title="No loadout reported" detail="The harness publishes the tool set as it assembles it." />;
  }
  return (
    <div>
      {loadout === undefined ? null : (
        <>
          <div className={styles.sec}>
            <div className={styles.loadout}>
              <span className={styles.big}>{loadout.active.length}</span>
              <span className={styles.of}>active</span>
              <Chip tone="info">{loadout.withheldCount} withheld</Chip>
            </div>
            <div className={styles.pills}>
              {loadout.active.map(name => <span className={styles.pill} key={name}>{name}</span>)}
            </div>
          </div>

          <div className={styles.sec}>
            <SectionHead label="always active" count={loadout.alwaysActive.length} />
            {loadout.alwaysActive.length === 0
              ? <Empty title="Nothing is always active" detail="Every tool in this run had to be searched for." />
              : (
                <div className={styles.pills}>
                  {loadout.alwaysActive.map(name => <span className={styles.pill} key={name}>{name}</span>)}
                </div>
              )}
          </div>

          <div className={styles.sec}>
            <SectionHead label="searched in via find_tools" count={loadout.searchedIn.length} />
            {loadout.searchedIn.length === 0
              ? (
                <Empty
                  title="find_tools not in this loadout"
                  detail="This agent runs closed — it cannot pull new tools mid-run."
                />
              )
              : loadout.searchedIn.map(query => (
                <div className={styles.query} key={query}>
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="6" cy="6" r="4.2" />
                    <path d="M9.2 9.2 12.5 12.5" />
                  </svg>
                  find_tools(<span className={styles.queryText}>&quot;{query}&quot;</span>)
                </div>
              ))}
          </div>
        </>
      )}

      <div className={styles.sec}>
        <SectionHead label="hired sub-runs" count={subagents.length} />
        {subagents.length === 0
          ? <Empty title="No subagent hired" detail="Nothing in this turn delegated to a sub-run." />
          : subagents.map(part => (
            <div className={styles.subCard} key={part.seq}>
              <div className={styles.subHead}>
                <span className={styles.subName}>{part.event.label}</span>
                <span className={styles.pushRight}>
                  <Chip tone="ok">{part.event.steps} / {part.event.maxSteps} steps</Chip>
                </span>
              </div>
              {part.event.report === undefined
                ? <div className={styles.e2}>No report came back.</div>
                : (
                  <div className={styles.quote}>
                    <em className={styles.quoteLabel}>report back</em>
                    {part.event.report}
                  </div>
                )}
            </div>
          ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- guard */

export function GuardPanel({ parts }: PanelProps) {
  const calls = eventsOf(parts, "tool");
  if (calls.length === 0) {
    return <Empty title="No tool calls this turn" detail="Nothing reached the guard, so nothing was decided." />;
  }
  const tally = (decision: string) => calls.filter(call => call.event.guard === decision).length;
  return (
    <div>
      <div className={styles.guardSum}>
        <span>{calls.length} tool calls this turn</span>
        <Chip tone="ok">{tally("run")} run</Chip>
        <Chip tone="warn">{tally("ask")} ask</Chip>
        <Chip tone={tally("block") > 0 ? "bad" : "mute"}>{tally("block")} block</Chip>
      </div>
      <table className={styles.g}>
        <thead>
          <tr>
            <th>#</th>
            <th>tool</th>
            <th>decision</th>
            <th>approval</th>
            <th>status</th>
            <th className={styles.r}>duration</th>
          </tr>
        </thead>
        <tbody>
          {calls.map(call => (
            <tr key={call.event.toolCallId}>
              <td className={styles.gStep}>{String(call.event.step).padStart(2, "0")}</td>
              <td className={styles.gName}>
                {call.event.name}
                {call.agent === "resident" ? null : <span className={styles.gSub}>{call.agent}</span>}
              </td>
              <td>
                {call.event.guard === undefined
                  ? <span className={styles.e2}>—</span>
                  : <Chip tone={GUARD_TONE[call.event.guard] ?? "mute"}>{call.event.guard}</Chip>}
              </td>
              {/* Plain words, not a chip: most rows say "auto", and a column of
                  identical badges is noise the eye has to step over. */}
              <td
                className={clsx(
                  styles.gApproval,
                  APPROVAL_TONE[call.event.approval ?? ""] === "ok" && styles.gApprovalOk,
                  APPROVAL_TONE[call.event.approval ?? ""] === "bad" && styles.gApprovalBad,
                )}
              >
                {call.event.approval ?? "—"}
              </td>
              <td><Chip tone={STATUS_TONE[call.event.status] ?? "mute"}>{call.event.status}</Chip></td>
              <td className={clsx(styles.r, styles.dur)}>{duration(call.event.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ raw */

export function RawPanel({ parts }: PanelProps) {
  const [query, setQuery] = useState("");
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const kinds = [...new Set(parts.map(part => part.event.kind))];
  const start = parts[0]?.at ?? 0;
  const needle = query.trim().toLowerCase();
  const shown = parts.filter(part =>
    !off.has(part.event.kind)
    && (needle === "" || `${part.event.kind} ${part.agent} ${describe(part.event)}`.toLowerCase().includes(needle)));
  return (
    <div className={styles.rawCard}>
      <div className={styles.rawHead}>
        <span className={styles.rawLabel}>stream</span>
        <span className={styles.rawTitle}>data-vendo-debug</span>
        <span className={clsx(styles.rawLabel, styles.pushRight)}>{shown.length} / {parts.length}</span>
        <button
          type="button"
          className={styles.ghostBtn}
          onClick={() => void navigator.clipboard?.writeText(JSON.stringify(parts, null, 2))}
        >
          copy
        </button>
      </div>
      <div className={styles.filter}>
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="filter events…"
          aria-label="Filter events"
        />
        {kinds.map(kind => (
          <button
            type="button"
            key={kind}
            className={clsx(styles.fchip, !off.has(kind) && styles.fchipOn)}
            aria-pressed={!off.has(kind)}
            onClick={() => setOff(current => {
              const next = new Set(current);
              if (!next.delete(kind)) next.add(kind);
              return next;
            })}
          >
            {kind}
          </button>
        ))}
      </div>
      {shown.length === 0
        ? <div className={styles.feedEmpty}>No events match this filter.</div>
        : shown.map(part => (
          <div className={styles.frow} key={part.seq}>
            <span className={styles.frowAt}>+{((part.at - start) / 1000).toFixed(2)}</span>
            <span><Chip tone={TONES[part.event.kind]}>{part.event.kind}</Chip></span>
            <span className={styles.frowMsg}>{describe(part.event)}</span>
          </div>
        ))}
    </div>
  );
}
