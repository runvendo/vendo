import { isVendoError } from "@vendoai/core";
import { useState } from "react";
import type { VendoClient } from "../client.js";
import { ApprovalCard, refusalCopy } from "./approval-card.js";
import { ChromeRoot } from "./chrome-root.js";
import { ResolvedApprovalCard } from "./embeds.js";
import { buildApprovalRequest } from "./thread/approval-wire.js";

/**
 * A parked ask, as an agent outside your product receives it. The WORDS are
 * already chosen: such an agent never holds the `ApprovalRequest` the shared
 * ladder derives them from (`consentAsk`, ruling 14), so the door renders the
 * ask before it leaves and ships that.
 */
export interface PendingApproval {
  /** The approval to decide (`apr_…`). */
  id: string;
  /** The question a person answers. */
  question: string;
  /** The quiet facts under it — every input the question does not already name,
   *  and what approving does. One line to the eye, a list to a screen reader. */
  notes: string[];
}

export interface VendoApprovalProps {
  /** The `approval` block off the parked call's outcome. */
  approval: PendingApproval;
  /** The wire the decision is spent on. Explicit, because the agent that asked
   *  is outside your product and the page showing this card need not sit inside
   *  a `VendoProvider`. */
  client: VendoClient;
}

/**
 * The whole approval as ONE element: an agent outside your product parks a
 * guarded call, ships the ask to your page, and this asks it, decides it, and
 * settles itself.
 *
 * THE card, not a card that looks like it (spec §16 — one consent surface
 * everywhere): `<ApprovalCard>` itself, with the ask handed to it in words
 * because this is the one surface with no `ApprovalRequest` to derive them from.
 * The wire carries the rendered ask and nothing else, so the request below is
 * the shared §16 builder's honest minimum — no call, no schema, no grade.
 *
 * No `remember`: a grant is a standing yes to a call the person chose to make,
 * and nothing on this page is theirs to re-run. No venue byline either — the
 * wire carries no ctx, and printing one would be a guess.
 *
 * An ask that is no longer waiting — already answered on another surface, or
 * expired — settles into the same receipt a decision leaves, rather than
 * leaving buttons up that cannot work.
 */
export function VendoApproval({ approval, client }: VendoApprovalProps) {
  const [settled, setSettled] = useState<{ ok: boolean; line: string }>();
  if (settled !== undefined) {
    return (
      <ChromeRoot>
        <ResolvedApprovalCard summary={approval.question} ok={settled.ok} line={settled.line} />
      </ChromeRoot>
    );
  }
  return (
    <ApprovalCard
      approval={buildApprovalRequest({ approvalId: approval.id, toolCallId: approval.id, tool: "" }, {})}
      ask={approval}
      allowRemember={false}
      showContext={false}
      onDecide={async ({ approve }) => {
        try {
          await client.approvals.decide(approval.id, { approve });
        } catch (reason) {
          // The ask is SPENT, not broken: it was answered elsewhere or it
          // expired, so the card becomes its receipt. Anything else is this
          // decision failing — rethrown, so the card says so in its own words
          // and the question stays the person's to answer.
          const code = isVendoError(reason) ? reason.code : undefined;
          if (code !== "conflict" && code !== "not-found") throw reason;
          setSettled({ ok: false, line: refusalCopy(reason) });
          return;
        }
        setSettled({ ok: approve, line: approve ? "Approved — ran" : "Declined — nothing ran" });
      }}
    />
  );
}
