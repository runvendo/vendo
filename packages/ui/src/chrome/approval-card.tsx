import { canonicalJson, sha256Hex, type ApprovalDecision, type ApprovalRequest } from "@vendoai/core";
import { useState } from "react";
import { useVendoTools } from "../context.js";
import { ContainedNotice } from "../tree/notice.js";
import { ChromeRoot } from "./chrome-root.js";
import { toolTitle } from "./humanize.js";

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
   * ENG-216 — show the `venue · presence · appId` context byline. Queue
   * surfaces carry a real server `ctx` and keep it (default true); the
   * in-thread card sets this false because the live conversation is already
   * the context and the wire carries no ctx to display honestly.
   */
  showContext?: boolean;
}

function approvalDate(grantedAt: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(grantedAt),
  );
}

/** 01-core §5; 08-ui §4 — the one consent surface, always showing real inputs. */
export function ApprovalCard({ approval, onDecide, allowRemember = true, showContext = true }: ApprovalCardProps) {
  const [remember, setRemember] = useState(false);
  const [scope, setScope] = useState<"exact" | "tool">("exact");
  const [duration, setDuration] = useState<"session" | "standing">("session");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const critical = approval.descriptor.risk === "destructive" || approval.descriptor.critical === true;
  // ENG-216 — humanize: host label wins, else the prettified tool id. Never the
  // raw slug. The description subtitle shows only when it adds information.
  const meta = useVendoTools()[approval.descriptor.name];
  const title = toolTitle(approval.descriptor.name, meta);
  const description = (meta?.description ?? approval.descriptor.description).trim();
  const showDescription = description.length > 0 && description !== title;

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
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ChromeRoot>
      <article className={`fl-approval fl-item-in${critical ? " fl-approval--ceremony" : ""}`} aria-label={`Approval for ${title}`}>
        <div className="fl-approval-head">
          <span className="fl-approval-ic" aria-hidden="true">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
            </svg>
          </span>
          <div className="fl-approval-heading">
            <div className="fl-approval-eyebrow">{critical ? "CRITICAL" : "REQUESTED"}</div>
            <div className="fl-approval-title">{title}</div>
            {showDescription ? <div className="fl-approval-desc">{description}</div> : null}
          </div>
          <span
            className="fl-chip"
            data-risk={approval.descriptor.risk}
            style={{ marginLeft: "auto", padding: "2px 7px", fontSize: "10px", cursor: "default" }}
          >
            {approval.descriptor.risk}
          </span>
        </div>
        <pre
          className="fl-approval-fields"
          aria-label="Real tool inputs"
          style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {approval.inputPreview}
        </pre>
        {showContext ? (
          <div className="fl-approval-more" style={{ marginTop: "8px" }}>
            {approval.ctx.venue} · {approval.ctx.presence}
            {approval.ctx.appId ? ` · ${approval.ctx.appId}` : ""}
          </div>
        ) : null}
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
        <div className="fl-approval-actions">
          <button className={`fl-btn ${critical ? "fl-btn-ceremony" : "fl-btn-primary"}`} type="button" disabled={busy} onClick={() => void decide(true)}>Approve</button>
          <button className="fl-btn" type="button" disabled={busy} onClick={() => void decide(false)}>Deny</button>
        </div>
      </article>
    </ChromeRoot>
  );
}
