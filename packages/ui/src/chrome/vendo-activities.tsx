import type { ApprovalRequest } from "@vendoai/core";
import { useId, useState } from "react";
import { useActivity } from "../hooks/use-activity.js";
import { useApprovals } from "../hooks/use-approvals.js";
import { useAutomations } from "../hooks/use-automations.js";
import { useVendoTools } from "../context.js";
import { ActivityLedger } from "./activity-ledger.js";
import { ApprovalCard } from "./approval-card.js";
import { ChromeRoot } from "./chrome-root.js";
import { GrantSetCard } from "./grant-set-card.js";

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

/** One pager entry: a lone approval, or an automation's WHOLE grant set —
 *  standing-grant asks for one app decide together (one consent moment;
 *  deciding a member alone would resume a set-parked thread half-granted). */
type QueueItem =
  | { kind: "single"; id: string; ask: ApprovalRequest }
  | { kind: "set"; id: string; appId: string; asks: ApprovalRequest[] };

function queueItems(pending: ApprovalRequest[]): QueueItem[] {
  const items: QueueItem[] = [];
  const sets = new Map<string, QueueItem & { kind: "set" }>();
  for (const ask of pending) {
    if (ask.ctx.venue === "automation" && ask.ctx.appId !== undefined) {
      const existing = sets.get(ask.ctx.appId);
      if (existing !== undefined) {
        existing.asks.push(ask);
        continue;
      }
      const item = { kind: "set" as const, id: `set:${ask.ctx.appId}`, appId: ask.ctx.appId, asks: [ask] };
      sets.set(ask.ctx.appId, item);
      items.push(item);
      continue;
    }
    items.push({ kind: "single", id: ask.id, ask });
  }
  return items;
}

/**
 * The shelf's drop-in feed of what the agent did + what it is waiting on
 * (ui-usage-dx §2) — placeable in any host page. Pending approvals render as
 * ONE card with a "1 of N" pager (ui-lane-panels pick B): deciding slides the
 * next approval into place instead of stacking a wall of cards. An
 * automation's standing-grant SET is one pager entry (the grant-set card):
 * one Approve grants every permission atomically. Recent activity renders as
 * the shared icon ledger below. When nothing has happened yet it shows a
 * quiet one-line empty state rather than rendering nothing — hosts place
 * this in their own pages, and an invisible component would read as broken.
 */
export function VendoActivities({ pollMs = 5000, maxItems = 8 }: VendoActivitiesProps = {}) {
  const poll = pollMs > 0 ? { pollMs } : undefined;
  const { pending, decide } = useApprovals(poll);
  // Names + set ids for grant-set entries (the asks alone carry only appId).
  // No poll of its own: the queue's shape only changes with `pending`.
  const automations = useAutomations();
  const { events, isLoading } = useActivity(poll);
  const tools = useVendoTools();
  const headingId = useId();
  const recent = events.slice(0, Math.max(0, maxItems));
  const queue = queueItems(pending);

  // The pager holds a POSITION, not an approval: deciding removes the current
  // entry from the queue, so the next one shifts into the same index and
  // slides in (keyed by entry id). Clamp when the queue shrinks below it.
  const [rawIndex, setRawIndex] = useState(0);
  const index = Math.min(rawIndex, Math.max(0, queue.length - 1));
  const current = queue[index];
  const paged = queue.length > 1;
  const afterDecide = () => setRawIndex(value => Math.min(value, Math.max(0, queue.length - 2)));

  return (
    <ChromeRoot>
      <section aria-label="Vendo activity" style={{ display: "grid", gap: "14px" }}>
        {current ? (
          <section aria-labelledby={`${headingId}-approvals`} style={{ display: "grid", gap: "10px" }}>
            <header>
              <div className={paged ? "fl-approvals-pager" : undefined}>
                <h2 id={`${headingId}-approvals`} className="fl-act-head-lbl" style={{ margin: 0, fontSize: "14px" }}>
                  Needs your approval
                </h2>
                {paged ? (
                  <>
                    <p className="fl-act-now" style={{ margin: 0, fontSize: "11.5px" }} aria-live="polite">
                      · {index + 1} of {queue.length}
                    </p>
                    <span className="fl-approvals-dots" aria-hidden="true">
                      {queue.map((item, i) => (
                        <span key={item.id} className={`fl-approvals-dot${i === index ? " fl-approvals-dot--on" : ""}`} />
                      ))}
                    </span>
                  </>
                ) : null}
              </div>
              <p className="fl-act-now" style={{ margin: "3px 0 0", fontSize: "12.5px" }}>
                An agent asked to act on your account. Review the exact request before it runs.
              </p>
            </header>
            <div className="fl-approvals-stack">
              <div key={current.id} className="fl-approvals-slide">
                {current.kind === "set" ? (() => {
                  const entry = automations.automations.find(candidate => candidate.app.id === current.appId);
                  return (
                    <GrantSetCard
                      name={entry?.app.name ?? "This automation"}
                      permissions={current.asks.map(ask => ({
                        approvalId: ask.id,
                        tool: ask.call.tool,
                        ...(ask.descriptor.description.length > 0 ? { description: ask.descriptor.description } : {}),
                        risk: ask.descriptor.risk,
                      }))}
                      state="parked"
                      onDecide={async approve => {
                        // ONE decision settles the whole set; the announcement
                        // (member ids + set id) resumes any parked thread.
                        await decide(
                          current.asks.map(ask => ask.id),
                          { approve },
                          entry?.grantSetId === undefined ? undefined : { grantSetId: entry.grantSetId },
                        );
                        afterDecide();
                      }}
                    />
                  );
                })() : (
                  <ApprovalCard
                    approval={current.ask}
                    onDecide={async decision => {
                      await decide(current.ask.id, decision);
                      afterDecide();
                    }}
                  />
                )}
              </div>
              {index < queue.length - 1 ? <div className="fl-approvals-ghost" aria-hidden="true" /> : null}
            </div>
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
            <>
              <p className="fl-act-cap" style={{ margin: 0 }}>Actions performed as your account</p>
              <ActivityLedger events={recent} tools={tools} />
            </>
          )}
        </section>
      </section>
    </ChromeRoot>
  );
}
