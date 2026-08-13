import {
  canonicalJson,
  sha256Hex,
  type ApprovalDecision,
  type ApprovalRequest,
} from "@vendoai/core";
import { useState } from "react";
import { useVendoTools } from "../context.js";
import { ContainedNotice } from "../tree/notice.js";
import { consentAsk, toolPresentation } from "./build-beat.js";
import { CardActions, CardLine, CardShell } from "./card-shell.js";
import { ChromeRoot } from "./chrome-root.js";
import { fieldRows } from "./field-rows.js";

const VENUE_LABEL: Record<string, string> = {
  chat: "asked here in chat",
  page: "asked on the page",
  slot: "asked in a view",
  voice: "asked by voice",
  mcp: "asked over MCP",
  app: "asked in an app",
  automation: "asked by an automation",
};

/** The same venues, once the surface can NAME the app or automation. */
const VENUE_NAMED: Record<string, (name: string) => string> = {
  app: name => `asked in ${name}`,
  automation: name => `asked by ${name}`,
};

/** Every Vendo id family is `<prefix>_<rest>` (core `ids.ts`: app_, apr_, grt_,
    run_, thr_). An id is not something a person can read, so this treats
    any id-shaped token as no name at all — whatever passed it in. */
const ID_SHAPED = /^[a-z]{2,6}_/;

/** ENG-216 — who is asking, in the user's language: one of the quiet notes under
 *  the question (M1 retired the byline row, and "runs as you" is already the
 *  agency note there, so only the venue phrase itself rides here).
 *
 *  THE DEFECT this exists for: the byline printed `approval.ctx.appId` verbatim,
 *  so a bank customer read "Runs as you · asked in an app · app_1". The wire
 *  carries only that id; a name arrives only when the SURFACE knows one (the
 *  activities queue resolves it off the automations list), and without one the
 *  bare phrase is the honest answer. An unknown venue says nothing rather
 *  than print its slug. */
export function venuePhrase(venue: string, venueName?: string): string | undefined {
  const name = venueName?.trim();
  const named = name !== undefined && name.length > 0 && !ID_SHAPED.test(name)
    ? VENUE_NAMED[venue]?.(name)
    : undefined;
  return named ?? VENUE_LABEL[venue];
}

export interface ApprovalCardProps {
  approval: ApprovalRequest;
  onDecide(decision: ApprovalDecision): void | PromiseLike<void>;
  /**
   * The in-thread native resume path (`addToolApprovalResponse`) has no
   * channel for `ApprovalDecision.remember`, so thread chrome hides the
   * disclosure rather than dropping the answer silently. Queue surfaces
   * (the real wire decision) keep it. Default true.
   */
  allowRemember?: boolean;
  /**
   * ENG-216 — show the venue context note. Queue surfaces carry a real server
   * `ctx` and keep it (default true); the in-thread card sets this false because
   * the live conversation is already the context and the wire carries no ctx to
   * display honestly.
   */
  showContext?: boolean;
  /**
   * A human name for the app/automation that asked, when the SURFACE knows one
   * (the wire's `ctx` carries only an id). Absent ⇒ the bare venue phrase; an
   * id-shaped value is refused, since an id in front of a user is the defect
   * this prop exists to remove.
   */
  venueName?: string;
}

/** The consumer's half of a refusal (spec §16 law 3) — the same defect the
 *  connect and standing-access cards carried: this card rendered whatever
 *  `onDecide` threw, and the wire's sentences carry approval and app ids. The
 *  developer sentence keeps its home in the server's own error; the person
 *  looking at the card is told what it means for them. `refusalCopy` in
 *  grant-set-card.tsx is the pattern. */
export function refusalCopy(reason: unknown): string {
  const code = (reason as { code?: unknown } | null)?.code;
  if (code === "not-found") return "This request isn’t waiting on you any more — it may have expired.";
  if (code === "conflict") return "This request was already answered.";
  if (code === "forbidden") return "This request isn’t yours to answer.";
  if (code === "cloud-required") return "Answering this isn’t turned on for this workspace yet.";
  return "That didn’t go through — nothing was approved. Try again in a moment.";
}

function approvalDate(grantedAt: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(grantedAt),
  );
}

/** 01-core §5; 08-ui §4; spec §16 — the one consent surface, on the one card
    shell: the ask as a question, one quiet line carrying every real input the
    question doesn't already name plus what approving does, and two buttons. */
export function ApprovalCard({ approval, onDecide, allowRemember = true, showContext = true, venueName }: ApprovalCardProps) {
  const [remember, setRemember] = useState(false);
  const [scope, setScope] = useState<"exact" | "tool">("exact");
  const [duration, setDuration] = useState<"session" | "standing">("session");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // ENG-216 humanization (host ToolMeta wins, else the prettified id — never
  // the raw slug) layered with the consent presentation.
  // H-1 — ONE field, on both surfaces. The card read `descriptor.name` and the
  // queue row read `call.tool`, so a server-served ask whose descriptor is
  // named differently from the call printed two different sentences for one
  // ask — and the card additionally missed the host's `ToolMeta`, which is
  // keyed by the WIRE tool id. `call.tool` is what will actually run, so it is
  // the field every surface reads.
  const tool = approval.call.tool;
  const meta = useVendoTools()[tool];
  const presentation = toolPresentation(
    tool,
    approval.call.args,
    meta,
    approval.descriptor.title,
    approval.descriptor.inputSchema,
  );
  // Ruling 14 — ONE plain-words ladder, shared with the queue row (`consentAsk`
  // in build-beat.tsx). The descriptor's own description is never on it.
  const ask = consentAsk(
    approval.descriptor.risk,
    presentation,
    fieldRows(approval.call.args, approval.descriptor.inputSchema, meta),
    meta,
  );
  const venue = showContext ? venuePhrase(approval.ctx.venue, venueName) : undefined;
  const notes = venue === undefined ? ask.notes : [...ask.notes, venue];

  const decide = async (approve: boolean) => {
    const decision: ApprovalDecision = { approve };
    if (approve && allowRemember && remember) {
      decision.remember = {
        scope: scope === "tool"
          ? { kind: "tool" }
          : {
              kind: "exact",
              inputHash: `sha256:${sha256Hex(canonicalJson(approval.call.args))}`,
              inputPreview: approval.inputPreview,
            },
        duration,
      };
    }
    setBusy(true);
    setError(undefined);
    try {
      await onDecide(decision);
    } catch (reason) {
      setError(refusalCopy(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ChromeRoot>
      {/* The risk grade and the raw tool slug are machine affordances — a slug is
          not something a person reads, and neither is a grade. They used to ride
          a visible chip; the attributes are their real home. */}
      <CardShell
        label={`Approval for ${presentation.title}`}
        className="fl-approval fl-item-in"
        data-risk={approval.descriptor.risk}
        data-vendo-tool={tool}
      >
        {/* M1 — the question IS the interface. Law 3 lives across this pair: the
            question names the action and its key values, the quiet line under it
            carries every remaining real input and what approving does. */}
        <CardLine className="fl-approval-ask">{ask.question}</CardLine>
        {/* One LINE to the eye, a LIST to a screen reader: the notes are a set
            of distinct facts (each remaining input, what approving does, who
            asked), and a joined paragraph gave a reader no way to step through
            them — the field table it replaced was navigable. The " · " between
            them is punctuation, so it is drawn in CSS rather than read out. */}
        <ul className="fl-approval-sub" aria-label="Request details">
          {notes.map((note, index) => <li key={index}>{note}</li>)}
        </ul>
        {approval.invalidatedGrant ? (
          <div style={{ marginTop: "12px" }}>
            <ContainedNotice label="Previous permission invalidated">
              {`This tool changed since you approved it on ${approvalDate(approval.invalidatedGrant.grantedAt)} — your previous permission no longer applies.`}
            </ContainedNotice>
          </div>
        ) : null}
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        <CardActions>
          <button className="fl-btn fl-btn-primary" type="button" disabled={busy} onClick={() => void decide(true)}>Approve</button>
          <button className="fl-btn" type="button" disabled={busy} onClick={() => void decide(false)}>Deny</button>
          {/* Not part of the ask — it settles the NEXT one like it — so it rides
              the actions row as the quiet trailing control and stays closed. The
              card at rest is the question, the line, and two buttons. */}
          {allowRemember ? (
            <details className="fl-auto-details fl-approval-remember">
              <summary>Remember this decision</summary>
              <div className="fl-approval-batch-list">
                <div className="fl-approval-batch-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={event => setRemember(event.currentTarget.checked)}
                    />
                    Create a reusable grant when approved
                  </label>
                </div>
                <fieldset disabled={!remember} style={{ margin: 0, padding: 0, border: 0 }}>
                  <legend className="fl-approval-more">Scope</legend>
                  <div className="fl-approval-batch-row">
                    <label><input type="radio" name={`scope-${approval.id}`} checked={scope === "exact"} onChange={() => setScope("exact")} style={{ accentColor: "var(--vendo-accent)" }} />This exact input</label>
                  </div>
                  <div className="fl-approval-batch-row">
                    <label><input type="radio" name={`scope-${approval.id}`} checked={scope === "tool"} onChange={() => setScope("tool")} style={{ accentColor: "var(--vendo-accent)" }} />The whole tool</label>
                  </div>
                </fieldset>
                <fieldset disabled={!remember} style={{ margin: 0, padding: 0, border: 0 }}>
                  <legend className="fl-approval-more">Duration</legend>
                  <div className="fl-approval-batch-row">
                    <label><input type="radio" name={`duration-${approval.id}`} checked={duration === "session"} onChange={() => setDuration("session")} style={{ accentColor: "var(--vendo-accent)" }} />This session</label>
                  </div>
                  <div className="fl-approval-batch-row">
                    <label><input type="radio" name={`duration-${approval.id}`} checked={duration === "standing"} onChange={() => setDuration("standing")} style={{ accentColor: "var(--vendo-accent)" }} />Standing</label>
                  </div>
                </fieldset>
              </div>
            </details>
          ) : null}
        </CardActions>
      </CardShell>
    </ChromeRoot>
  );
}
