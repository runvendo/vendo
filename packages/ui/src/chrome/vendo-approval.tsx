import { isVendoError } from "@vendoai/core";
import { useState } from "react";
import type { VendoClient } from "../client.js";
import { refusalCopy } from "./approval-card.js";
import { CardActions, CardLine, CardShell, NOTE_SEPARATOR } from "./card-shell.js";
import { ChromeRoot } from "./chrome-root.js";
import { ResolvedApprovalCard } from "./embeds.js";

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
 * The same card the in-product agent asks on (spec §16 — one shell everywhere),
 * and the same receipt it leaves behind. An ask that is no longer waiting —
 * already answered on another surface, or expired — settles into that receipt
 * too, rather than leaving buttons up that cannot work.
 */
export function VendoApproval({ approval, client }: VendoApprovalProps) {
  const [settled, setSettled] = useState<{ ok: boolean; line: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await client.approvals.decide(approval.id, { approve });
      setSettled({ ok: approve, line: approve ? "Approved — ran" : "Declined — nothing ran" });
    } catch (reason) {
      const code = isVendoError(reason) ? reason.code : undefined;
      // The ask is SPENT, not broken: it was answered elsewhere or it expired,
      // so the card becomes its receipt. Anything else is this decision
      // failing, and the question is still the user's to answer.
      if (code === "conflict" || code === "not-found") setSettled({ ok: false, line: refusalCopy(reason) });
      else setError(refusalCopy(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ChromeRoot>
      {settled === undefined ? (
        <CardShell label={`Approval for ${approval.question}`} className="fl-approval">
          <CardLine className="fl-approval-ask">{approval.question}</CardLine>
          {/* One LINE to the eye, a LIST to a screen reader — the ask card's own
              treatment, `NOTE_SEPARATOR` as real text and all (card-shell.tsx). */}
          <ul className="fl-approval-sub" aria-label="Request details">
            {approval.notes.map((note, index) => (
              <li key={index}>{index > 0 ? NOTE_SEPARATOR : null}{note}</li>
            ))}
          </ul>
          {error ? <div role="alert" className="fl-error">{error}</div> : null}
          <CardActions>
            <button className="fl-btn fl-btn-primary" type="button" disabled={busy} onClick={() => void decide(true)}>Approve</button>
            <button className="fl-btn" type="button" disabled={busy} onClick={() => void decide(false)}>Deny</button>
          </CardActions>
        </CardShell>
      ) : (
        <ResolvedApprovalCard summary={approval.question} ok={settled.ok} line={settled.line} />
      )}
    </ChromeRoot>
  );
}
