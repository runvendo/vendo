import type { ApprovalRequest, Json } from "@vendoai/core";
import { approvalTitle, humanize, type VoiceApprovalReceipt } from "./use-voice-approvals.js";

export interface VoiceConsentProps {
  request?: ApprovalRequest;
  receipt?: VoiceApprovalReceipt;
  listening: boolean;
  busy: boolean;
  error?: string;
  /** C-A spoken-yes — a recognized spoken decision; flips the hint to "heard". */
  intent?: "approve" | "decline" | null;
  onDecide(request: ApprovalRequest, approve: boolean): void;
}

export function VoiceConsent({ request, receipt, listening, busy, error, intent, onDecide }: VoiceConsentProps) {
  if (!request && receipt) {
    return (
      <div
        className={`fl-voice-consent is-receipt${receipt.approved ? "" : " is-declined"}`}
        role="status"
        aria-live="polite"
      >
        {receipt.approved ? "Approved" : "Declined"}: {receipt.title}
      </div>
    );
  }
  if (!request) return null;

  const critical = request.descriptor.risk === "destructive" || request.descriptor.critical === true;
  const automation = isAutomation(request);
  const title = approvalTitle(request);
  const fact = approvalFact(request);

  if (automation) {
    return (
      <div className="fl-voice-consent is-automation" role="status" aria-live="polite">
        <article className={`fl-approval${critical ? " fl-approval-critical" : ""}`} aria-label={`Approval for ${title}`}>
          <div className="fl-approval-head">
            <span className="fl-approval-ic" aria-hidden="true"><ShieldIcon /></span>
            <div>
              <div className="fl-approval-eyebrow">Automation request</div>
              <div className="fl-approval-title">{title}</div>
            </div>
          </div>
          {fact ? <div className="fl-approval-fields">{fact}</div> : null}
          <div className="fl-approval-consequence">This can run on its own after you approve it.</div>
          {error ? <div className="fl-tool-err" role="alert">{error}</div> : null}
          <div className="fl-approval-actions">
            <button type="button" className="fl-btn" disabled={busy} onClick={() => onDecide(request, false)}>Decline</button>
            <button
              type="button"
              className={`fl-btn ${critical ? "fl-btn-critical" : "fl-btn-primary"}`}
              disabled={busy}
              onClick={() => onDecide(request, true)}
            >
              {critical ? `Confirm — ${title}` : "Approve"}
            </button>
          </div>
        </article>
      </div>
    );
  }

  return (
    <div
      className={`fl-voice-consent${critical ? " is-critical" : listening ? " is-listening" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="fl-voice-consent-ic" aria-hidden="true"><ShieldIcon /></span>
      <div className="fl-voice-consent-copy">
        <span className="fl-voice-consent-title">{title}</span>
        {fact ? <span className="fl-voice-consent-fact">{fact}</span> : null}
        {critical ? <span className="fl-voice-consent-warn">Confirm this action by hand</span> : null}
        {!critical && listening ? (
          intent === "approve" ? (
            <span className="fl-voice-consent-hint is-heard" role="status">&ldquo;Approve&rdquo; heard ✓</span>
          ) : intent === "decline" ? (
            <span className="fl-voice-consent-hint is-heard" role="status">&ldquo;Decline&rdquo; heard ✓</span>
          ) : (
            <span className="fl-voice-consent-hint">
              Say &ldquo;approve&rdquo; — or tap
              <span className="fl-voice-eq" aria-hidden="true"><i /><i /><i /></span>
            </span>
          )
        ) : null}
        {error ? <span className="fl-tool-err" role="alert">{error}</span> : null}
      </div>
      <div className="fl-voice-consent-actions">
        <button type="button" className="fl-btn" disabled={busy} onClick={() => onDecide(request, false)}>Decline</button>
        <button
          type="button"
          className={`fl-btn ${critical ? "fl-btn-critical" : "fl-btn-primary"}`}
          disabled={busy}
          onClick={() => onDecide(request, true)}
        >
          {critical ? `Confirm — ${title}` : "Approve"}
        </button>
      </div>
    </div>
  );
}

function approvalFact(request: ApprovalRequest): string | undefined {
  const args = request.call.args;
  if (isRecord(args)) {
    const keys = ["amount", "recipient", "recipient_email", "to", "payee", "channel", "invoiceId"];
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return `${humanize(key)}: ${String(value)}`;
      }
    }
  }
  const preview = request.inputPreview.trim();
  if (!preview || preview.startsWith("{") || preview.startsWith("[")) return undefined;
  return preview.length > 120 ? `${preview.slice(0, 117)}…` : preview;
}

/** Exported for the stage's spoken-yes guard: automation requests use the rich
    card register with NO spoken affordance, so an intent must never decide one. */
export function isAutomation(request: ApprovalRequest): boolean {
  return request.ctx.venue === "automation" || [request.descriptor.name, request.descriptor.description, request.call.tool]
    .some((value) => /automation|schedule|recurring/i.test(value));
}

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ShieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}
