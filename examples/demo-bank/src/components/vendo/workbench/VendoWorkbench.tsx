"use client";

import clsx from "clsx";
import { useState } from "react";
import { developmentMode, useWorkbenchFeed } from "@vendoai/ui";
import { pushDemoFeed } from "./demo-feed";
import { count, duration, eventsOf, rows, share, turnStatus } from "./model";
import { ContextPanel, GuardPanel, RawPanel, TimelinePanel, ToolsPanel } from "./panels";
import { Chip, Empty } from "./parts";
import styles from "./workbench.module.css";

const TABS = ["timeline", "context", "tools", "guard", "raw"] as const;
type Tab = (typeof TABS)[number];

const PANELS = {
  timeline: TimelinePanel,
  context: ContextPanel,
  tools: ToolsPanel,
  guard: GuardPanel,
  raw: RawPanel,
} satisfies Record<Tab, unknown>;

/** Dev-only. In a production build this renders nothing at all — the hook and
 *  its subscription never mount. */
export function VendoWorkbench() {
  return developmentMode() ? <WorkbenchPane /> : null;
}

/**
 * `inertBehind` (@vendoai/ui) inerts every body child while the overlay is open,
 * and this pane is one — so with the chat up it was not merely dimmed by the
 * scrim, it was `inert`: no clicks, no keyboard, no screen reader. The workbench
 * reports on the turn THAT chat is running, which is exactly when it has to be
 * live, so it declares itself the way the mechanism asks a Vendo surface to
 * (`EXEMPT` in inert-behind.ts). The CSS raises it over the scrim to match.
 */
const ABOVE_MODAL = { "data-vendo-portal": "" };

function WorkbenchPane() {
  const feed = useWorkbenchFeed();
  const [collapsed, setCollapsed] = useState(true);
  const [picked, setPicked] = useState<string>();
  const [tab, setTab] = useState<Tab>("timeline");

  if (collapsed) {
    return (
      <button type="button" className={styles.rail} onClick={() => setCollapsed(false)} {...ABOVE_MODAL}>
        workbench{feed.length === 0 ? "" : ` · ${feed.length}`}
      </button>
    );
  }

  const turn = feed.find(candidate => candidate.turnId === picked) ?? feed.at(-1);
  const parts = turn?.parts ?? [];
  const status = turnStatus(parts);
  const loadout = eventsOf(parts, "loadout").at(-1)?.event;
  const steps = rows(parts).filter(row => row.kind === "step").length;
  // The badge is one number, so it names the turn's own thinker: the resident is
  // the first loop to measure its window, and a screen run's separate reading has
  // its own gauge in the panel rather than overwriting this one.
  const context = status.contexts[0]?.event;
  const contextPct = context === undefined
    ? undefined
    : share(context.estTokens, context.windowTokens);
  const Panel = PANELS[tab];

  return (
    <aside className={styles.pane} aria-label="Harness workbench" {...ABOVE_MODAL}>
      <header className={styles.head}>
        <div className={styles.headTop}>
          <h2 className={styles.title}>Harness Workbench</h2>
          <span className={styles.chipDev}>dev only</span>
          <div className={styles.headActions}>
            <button type="button" className={styles.ghostBtn} onClick={pushDemoFeed}>demo feed</button>
            <button type="button" className={styles.ghostBtn} onClick={() => setCollapsed(true)}>hide</button>
          </div>
        </div>

        {feed.length === 0 ? null : (
          <div className={styles.turnSwitch} role="tablist" aria-label="Turn">
            {feed.map(candidate => (
              <button
                type="button"
                key={candidate.turnId}
                role="tab"
                aria-selected={candidate.turnId === turn?.turnId}
                className={clsx(styles.tsBtn, candidate.turnId === turn?.turnId && styles.tsBtnOn)}
                onClick={() => setPicked(candidate.turnId)}
              >
                {candidate.turnId}
                <span className={styles.tsId}>{candidate.parts.length}</span>
              </button>
            ))}
          </div>
        )}

        {turn === undefined ? null : (
          <div className={styles.status}>
            <div className={styles.stat}>
              <div className={styles.lbl}>status</div>
              <div className={styles.val}>
                <span className={clsx(styles.pulse, status.running && styles.pulseRun)} />
                {status.running ? "running" : "idle"}
                {status.outcome === undefined ? null : <Chip tone={status.outcome.tone}>{status.outcome.label}</Chip>}
              </div>
            </div>
            <div className={clsx(styles.stat, styles.statProg)}>
              <div className={styles.lbl}>step</div>
              <div className={styles.val}>
                {status.step ?? "—"} <span className={styles.dim}>/ {status.maxSteps ?? "—"}</span>
              </div>
              <div className={clsx(styles.prog, !status.running && styles.progDone)}>
                <i style={{ width: `${share(status.step ?? 0, status.maxSteps ?? 0)}%` }} />
              </div>
            </div>
            <div className={styles.stat}>
              <div className={styles.lbl}>elapsed</div>
              <div className={styles.val}>{duration(status.elapsedMs)}</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.lbl}>agents</div>
              <div className={styles.val}>
                {status.agents.map(agent => <Chip key={agent} tone="mute">{agent}</Chip>)}
              </div>
            </div>
          </div>
        )}
      </header>

      <nav className={styles.tabs} role="tablist" aria-label="Workbench view">
        {TABS.map(name => (
          <button
            type="button"
            key={name}
            role="tab"
            aria-selected={name === tab}
            className={clsx(styles.tab, name === tab && styles.tabOn)}
            onClick={() => setTab(name)}
          >
            {name}
            <span className={styles.tabN}>
              {name === "timeline" ? steps
                : name === "context" ? (contextPct === undefined ? "—" : `${contextPct}%`)
                : name === "tools" ? (loadout?.active.length ?? "—")
                : name === "guard" ? eventsOf(parts, "tool").length
                : count(parts.length)}
            </span>
          </button>
        ))}
      </nav>

      <div className={styles.body} role="tabpanel">
        {turn === undefined
          ? (
            <Empty
              title="No turn has reported yet"
              detail="Ask Maple something — the harness publishes its diagnostics as the turn runs."
            />
          )
          : <Panel parts={parts} />}
      </div>
    </aside>
  );
}
