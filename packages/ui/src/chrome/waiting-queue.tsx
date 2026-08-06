/** ENG-193 §4.6 / ENG-225 / spec §4 (N1) — the "waiting on you" strip: every
    approval parked while the user was away, decidable in place.

    COUNT-FIRST: the strip is a slim "Waiting on you · N" row that expands the
    cards in place and clears itself the moment the queue empties. Native
    <details>, so the disclosure needs no state and keeps keyboard semantics.
    Height-capped with internal scroll (see .fl-waiting in chrome-css) so a deep
    inbox never starves the surface that mounts it.

    The rows are the SAME card shell the thread renders (spec §16): a queue row
    used to be its own hand-rolled layout showing the SERVER's `inputPreview`
    (the raw `tool slug + canonical JSON` the guard mints) — the one place an end
    user read our internals. The args are humanized here, client-side, exactly as
    they are in-thread. */
import type { ApprovalRequest } from "@vendoai/core";
import { useVendoProvider } from "../context.js";
import { useAttention } from "../hooks/use-approvals.js";
import { formatAuditTime } from "./activity-semantics.js";
import { consentWords, toolPresentation } from "./build-beat.js";
import {
  CardActions,
  CardByline,
  CardFields,
  CardHead,
  CardLine,
  CardShell,
  CARD_EYEBROWS,
  CLOCK_GLYPH,
  ToolkitLogo,
} from "./card-shell.js";
import { ChromeRoot } from "./chrome-root.js";
import { developmentMode } from "./dev-mode.js";
import { fieldRows } from "./field-rows.js";

export interface WaitingQueueProps {
  /** Poll cadence for pending approvals; 0 disables polling. */
  pollMs?: number;
}

function WaitingRow({ approval, onDecide }: {
  approval: ApprovalRequest;
  onDecide(approve: boolean): void;
}) {
  const { tools } = useVendoProvider();
  const meta = tools[approval.call.tool];
  const presentation = toolPresentation(
    approval.call.tool,
    approval.call.args,
    meta,
    approval.descriptor.title,
    approval.descriptor.inputSchema,
  );
  // A destructive ask reads as ceremony — the amber edge, same as in-thread.
  // #747: `critical` is `confirmEach` now, and `ungraded` earns the ceremony
  // too (an ask nobody graded never quietly folds). Same condition as the card.
  const ceremony = approval.descriptor.risk === "destructive"
    || approval.descriptor.risk === "ungraded"
    || approval.descriptor.confirmEach === true;
  const title = presentation.title;
  // The SAME plain-words ladder the card uses, from the same function (ruling
  // 14): host sentence → consequence from the real inputs → our own synthesized
  // sentence → the consequence class, and never the descriptor's own line. A
  // card and its queue row cannot say different things about one ask.
  const words = consentWords(approval.call.tool, approval.descriptor.risk, presentation, meta);
  return (
    <CardShell label={`Approval for ${title}`} ceremony={ceremony}>
      <CardHead
        icon={<ToolkitLogo {...(presentation.logoUrl === undefined ? {} : { src: presentation.logoUrl })} fallback={CLOCK_GLYPH} />}
        // The strip's own summary already says "Waiting on you"; the row says
        // what KIND of ask it is (the humanization source's own eyebrow).
        eyebrow={presentation.eyebrow}
        title={title}
      />
      <CardLine>{words.sentence}</CardLine>
      <CardFields rows={fieldRows(approval.call.args, approval.descriptor.inputSchema, meta)} />
      {/* The server's own preview is a debugging aid, not consumer copy. */}
      {developmentMode() ? <CardByline>{approval.inputPreview}</CardByline> : null}
      <CardActions>
        <button type="button" className="fl-btn" onClick={() => onDecide(false)}>Deny</button>
        <button type="button" className="fl-btn fl-btn-primary" onClick={() => onDecide(true)}>Approve</button>
      </CardActions>
      <CardByline>Asked {formatAuditTime(approval.createdAt)}</CardByline>
    </CardShell>
  );
}

/** The waiting-on-you queue (08-ui §4 chrome; mounted by VendoPage's chat
    workspace, exportable for any host placement). */
export function WaitingQueue({ pollMs = 5_000 }: WaitingQueueProps = {}) {
  // spec §4 (N1) — the strip counts from Lane D's ONE attention source, the
  // same hook the launcher badge reads, so the two can never disagree.
  const { askCount, asks, decide } = useAttention(pollMs > 0 ? { pollMs } : {});
  return (
    <ChromeRoot>
      {/* M31 — the announcement lives OUTSIDE the section, so it is mounted
          before the first ask exists. The strip itself appears and disappears,
          and a live region that mounts with its content is announced by nothing:
          a person who cannot see the strip appear was never told an approval had
          arrived. Count-first, in the strip's own words. */}
      <p className="fl-sr-only" role="status">
        {askCount === 0 ? "Nothing is waiting on you now."
          : askCount === 1 ? "1 thing needs you."
          : `${askCount} things need you.`}
      </p>
      {askCount === 0 ? null : (
      <section className="fl-waiting" aria-label="Waiting on you">
        <details className="fl-waiting-strip">
          <summary>{CARD_EYEBROWS.waiting} · {askCount}</summary>
          <div className="fl-waiting-cards">
            {asks.map(approval => (
              <WaitingRow
                key={approval.id}
                approval={approval}
                onDecide={approve => void decide(approval.id, { approve })}
              />
            ))}
          </div>
        </details>
      </section>
      )}
    </ChromeRoot>
  );
}
