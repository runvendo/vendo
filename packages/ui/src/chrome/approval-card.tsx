import {
  canonicalJson,
  sha256Hex,
  type ApprovalDecision,
  type ApprovalRequest,
} from "@vendoai/core";
import { useState } from "react";
import { useVendoTools } from "../context.js";
import { ContainedNotice } from "../tree/notice.js";
import { consentWords, toolPresentation } from "./build-beat.js";
import {
  CardActions,
  CardByline,
  CardFields,
  CardHead,
  CardLine,
  CardShell,
  SHIELD_GLYPH,
  ToolkitLogo,
} from "./card-shell.js";
import { ChromeRoot } from "./chrome-root.js";
import { developmentMode } from "./dev-mode.js";
import { fieldRows } from "./field-rows.js";

/** The wire risk slugs, in the user's language. The raw TOOL slug used to ride
    the chip's `title` tooltip "for developers" — a tooltip is an end-user
    surface (L37), so it is dev-mode only now; the slug's real home is the
    `data-risk`/`data-vendo-tool` attributes machines read. */
const RISK_LABEL: Record<string, string> = {
  read: "Read-only",
  write: "Makes changes",
  destructive: "Irreversible",
  ungraded: "Not reviewed",
};

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
    run_, thr_). An id is not something a person can read, so the byline treats
    any id-shaped token as no name at all — whatever passed it in. */
const ID_SHAPED = /^[a-z]{2,6}_/;

/** ENG-216 — who is asking, in the user's language.
 *
 *  THE DEFECT this exists for: the byline printed `approval.ctx.appId` verbatim,
 *  so a bank customer read "Runs as you · asked in an app · app_1". The wire
 *  carries only that id; a name arrives only when the SURFACE knows one (the
 *  activities queue resolves it off the automations list), and without one the
 *  bare phrase is the honest answer. An unknown venue drops the phrase rather
 *  than print its slug. */
export function venueByline(venue: string, venueName?: string): string {
  const name = venueName?.trim();
  const named = name !== undefined && name.length > 0 && !ID_SHAPED.test(name)
    ? VENUE_NAMED[venue]?.(name)
    : undefined;
  const phrase = named ?? VENUE_LABEL[venue];
  return phrase === undefined ? "Runs as you" : `Runs as you · ${phrase}`;
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
   * ENG-216 — show the venue context byline. Queue surfaces carry a real server
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
 *  adoption-card.tsx is the pattern. */
function refusalCopy(reason: unknown): string {
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
    shell, always showing the real inputs. */
export function ApprovalCard({ approval, onDecide, allowRemember = true, showContext = true, venueName }: ApprovalCardProps) {
  const [remember, setRemember] = useState(false);
  const [scope, setScope] = useState<"exact" | "tool">("exact");
  const [duration, setDuration] = useState<"session" | "standing">("session");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // #747 renamed `critical` → `confirmEach` (a GOVERNANCE flag — who must be
  // present — not a risk rung); host files may still spell it the old way and
  // core accepts that alias, so reading the new name here is enough.
  //
  // UNGRADED joins the condition, and does NOT duplicate main's semantics:
  // main makes the GUARD ask on ungraded; this makes the CARD keep its
  // ceremony — never fold the real inputs behind Details on an ask nobody has
  // graded. The chip still reads "Not reviewed", so the card claims none of
  // the irreversibility `destructive` would.
  const ceremony = approval.descriptor.risk === "destructive"
    || approval.descriptor.risk === "ungraded"
    || approval.descriptor.confirmEach === true;
  // ENG-216 humanization (host ToolMeta wins, else the prettified id — never
  // the raw slug) layered with the consent presentation: toolkit mark,
  // automation eyebrow, and a plain-language description synthesized from the
  // REAL inputs when the host supplies none.
  // H-1 — ONE field, on both surfaces. The card read `descriptor.name` and the
  // queue row read `call.tool`, so a server-served ask whose descriptor is
  // named differently from the call printed two different sentences for one
  // ask — and the card additionally missed the host's `ToolMeta`, which is
  // keyed by the WIRE tool id. `call.tool` is what will actually run, so it is
  // the field; waiting-queue.tsx reads the same one.
  const tool = approval.call.tool;
  const meta = useVendoTools()[tool];
  const presentation = toolPresentation(
    tool,
    approval.call.args,
    meta,
    approval.descriptor.title,
    approval.descriptor.inputSchema,
  );
  const title = presentation.title;
  const rows = fieldRows(approval.call.args, approval.descriptor.inputSchema, meta);
  // Ruling 14 — ONE plain-words ladder, shared with the queue row (`consentWords`
  // in build-beat.tsx): host sentence → consequence from the real inputs → our
  // own synthesized sentence → the consequence class. The descriptor's own
  // description is never on it.
  const words = consentWords(tool, approval.descriptor.risk, presentation, meta);
  const consequence = words.consequence;
  // The FOLD is the separate call: the raw fields tuck behind a "Details"
  // disclosure only on an ordinary ask. Critical/destructive keeps every input
  // in plain sight — maximum scrutiny — and still gets the sentence (a money
  // ask is exactly where "Vendo will run Send money as you." used to land).
  const foldFields = consequence !== undefined && !ceremony;

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

  const inputs = <CardFields rows={rows} />;
  return (
    <ChromeRoot>
      <CardShell label={`Approval for ${title}`} className="fl-approval fl-item-in" ceremony={ceremony}>
        <CardHead
          icon={<ToolkitLogo {...(presentation.logoUrl === undefined ? {} : { src: presentation.logoUrl })} fallback={SHIELD_GLYPH} />}
          eyebrow={presentation.eyebrow}
          title={title}
          aside={
            <span
              className="fl-chip"
              data-risk={approval.descriptor.risk}
              data-vendo-tool={tool}
              {...(developmentMode() ? { title: tool } : {})}
              style={{ marginLeft: "auto", padding: "2px 7px", fontSize: "10px", cursor: "default" }}
            >
              {RISK_LABEL[approval.descriptor.risk] ?? approval.descriptor.risk}
            </span>
          }
        />
        {/* Law 3 — the card always says what approving DOES: the synthesized
            consequence, else the described one, else the one thing that is
            true of every call. */}
        {consequence ? (
          <CardLine className="fl-approval-consequence-line">
            {consequence.pre}
            {consequence.artifact !== undefined ? <strong>{consequence.artifact}</strong> : null}
            {consequence.mid}
            {consequence.target !== undefined ? <strong>{consequence.target}</strong> : null}
            {consequence.post}
          </CardLine>
        ) : (
          <CardLine>{words.sentence}</CardLine>
        )}
        {/* The consequence sentence carries the meaning; the mechanical rows
            fold but never leave the DOM (the a11y contract keeps its name). */}
        {foldFields ? (
          <details className="fl-approval-details">
            <summary>Details — real inputs</summary>
            {inputs}
          </details>
        ) : inputs}
        {showContext ? <CardByline>{venueByline(approval.ctx.venue, venueName)}</CardByline> : null}
        {allowRemember ? (
          <details className="fl-auto-details">
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
        {approval.invalidatedGrant ? (
          <div style={{ marginTop: "12px" }}>
            <ContainedNotice label="Previous permission invalidated">
              {`This tool changed since you approved it on ${approvalDate(approval.invalidatedGrant.grantedAt)} — your previous permission no longer applies.`}
            </ContainedNotice>
          </div>
        ) : null}
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        <CardActions>
          <button className={`fl-btn ${ceremony ? "fl-btn-ceremony" : "fl-btn-primary"}`} type="button" disabled={busy} onClick={() => void decide(true)}>Approve</button>
          <button className="fl-btn" type="button" disabled={busy} onClick={() => void decide(false)}>Deny</button>
        </CardActions>
      </CardShell>
    </ChromeRoot>
  );
}
