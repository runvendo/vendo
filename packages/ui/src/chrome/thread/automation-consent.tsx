import { type ApprovalRequest, type AutomationId, type TriggerSource } from "@vendoai/core";
import { useMemo, useState } from "react";
import { useVendoProvider } from "../../context.js";
import { useApprovals } from "../../hooks/use-approvals.js";
import { AutomationCard } from "../automation-card.js";
import { GrantSetCard, grantSetPermissions } from "../grant-set-card.js";

/** The workspace panel's cadence — the shared approvals feed dedupes pollers,
    so a thread full of automation cards still polls on one rhythm. */
const CONSENT_POLL_MS = 5_000;

export interface ThreadAutomationConsentProps {
  automationId: AutomationId;
  name: string;
  enabled: boolean;
  when?: TriggerSource;
  action?: string;
  rules?: string[];
  description?: string;
  /** The wire part's creation-time count. The live feed supersedes it once it
   *  has answered — the part is a snapshot, and "waiting on N" must fall to
   *  zero the moment the person grants (on any surface). */
  pendingGrants?: number;
}

/**
 * The in-thread automation card as the ARMING consent surface (#1090).
 *
 * The overlay's conversation does not survive a page navigation (field:
 * linkwarden 2026-08-09), so a separate automations page structurally cannot
 * carry the arming decision — the asks must be decidable where the person
 * already is, on the card the arming itself raised. The asks ride the DURABLE
 * approvals feed, never the stream: reload-safe, live, and decided through
 * the same client path the workspace panel uses, so either surface's decision
 * settles the other (client.approvals.decide announces, both refresh).
 */
export function ThreadAutomationConsent(props: ThreadAutomationConsentProps) {
  const { client } = useVendoProvider();
  const approvals = useApprovals({ pollMs: CONSENT_POLL_MS });
  // The settled record outlives the feed rows for this session, so the card
  // says what just happened instead of silently dropping the consent block.
  const [settled, setSettled] = useState<{ state: "approved" | "denied"; asks: ApprovalRequest[] }>();
  const asks = useMemo(
    // An arming ask carries the RECORD it is for on `ctx.trigger` — an
    // automation has no app to match on.
    () => approvals.pending.filter(ask =>
      ask.ctx.venue === "automation" && ask.ctx.trigger?.automationId === props.automationId),
    [approvals.pending, props.automationId],
  );
  // Until the feed has answered cleanly, the part's snapshot count is the only
  // honest number — a feed error must not read as "nothing pending".
  const feedLive = !approvals.isLoading && approvals.error === undefined;
  const waitingOn = feedLive ? asks.length : props.pendingGrants ?? 0;

  const decide = async (approve: boolean) => {
    const deciding = asks;
    // The set id makes the decision atomic across the batch and lets a denial
    // disarm inside the same decision. Read at decide time from the
    // automations projection — the wire PART predates the set id (the record
    // carries it, the part does not), and a projection that cannot answer
    // must not block the decision: plain ids still settle every ask.
    const grantSetId = await client.automations.list()
      .then(entries => entries.find(entry => entry.id === props.automationId)?.grantSetId)
      .catch(() => undefined);
    await approvals.decide(
      deciding.map(ask => ask.id),
      { approve },
      grantSetId === undefined ? undefined : { grantSetId },
    );
    setSettled({ state: approve ? "approved" : "denied", asks: deciding });
    await approvals.refresh();
  };

  const shownAsks = settled === undefined ? asks : settled.asks;
  return (
    <>
      <AutomationCard
        name={props.name}
        // A denial of the WHOLE set disarms the automation in the same
        // decision (the engine's decide subscriber) — the card says so
        // immediately rather than waiting a poll tick.
        enabled={settled?.state === "denied" ? false : props.enabled}
        {...(props.when === undefined ? {} : { when: props.when })}
        {...(props.action === undefined ? {} : { action: props.action })}
        {...(props.rules === undefined ? {} : { rules: props.rules })}
        {...(props.description === undefined ? {} : { description: props.description })}
        pendingGrants={settled !== undefined ? 0 : waitingOn}
      />
      {shownAsks.length > 0 ? (
        <GrantSetCard
          name={props.name}
          permissions={grantSetPermissions(shownAsks)}
          state={settled?.state ?? "parked"}
          {...(settled === undefined ? { onDecide: decide } : {})}
        />
      ) : null}
    </>
  );
}
