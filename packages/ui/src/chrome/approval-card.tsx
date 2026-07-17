import { canonicalJson, sha256Hex, type ApprovalDecision, type ApprovalRequest } from "@vendoai/core";
import { useState } from "react";
import { ContainedNotice } from "../tree/notice.js";
import { toolPresentation } from "./build-beat.js";
import { ChromeRoot } from "./chrome-root.js";

/** Flat, primitive-valued args render as aligned field rows; anything nested
    falls back to the raw JSON preview (real inputs, always). */
function flatFields(args: unknown): Array<[string, string]> | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 8) return undefined;
  const rows: Array<[string, string]> = [];
  for (const [key, value] of entries) {
    if (value !== null && typeof value === "object") return undefined;
    rows.push([key, String(value)]);
  }
  return rows;
}

const VENUE_LABEL: Record<string, string> = {
  chat: "asked here in chat",
  page: "asked on the page",
  slot: "asked in a view",
  voice: "asked by voice",
  mcp: "asked over MCP",
  automation: "asked by an automation",
};

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
}

function approvalDate(grantedAt: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(grantedAt),
  );
}

/** 01-core §5; 08-ui §4 — the one consent surface, always showing real inputs. */
export function ApprovalCard({ approval, onDecide, allowRemember = true }: ApprovalCardProps) {
  const [remember, setRemember] = useState(false);
  const [scope, setScope] = useState<"exact" | "tool">("exact");
  const [duration, setDuration] = useState<"session" | "standing">("session");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const critical = approval.descriptor.risk === "destructive" || approval.descriptor.critical === true;
  const presentation = toolPresentation(approval.descriptor.name, approval.call.args);
  const fields = flatFields(approval.call.args);

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
      <article className={`fl-approval fl-item-in${critical ? " fl-approval--ceremony" : ""}`} aria-label={`Approval for ${approval.descriptor.name}`}>
        <div className="fl-approval-head">
          <span className="fl-approval-ic" aria-hidden="true">
            {presentation.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- chrome surface, plain img by design
              <img
                src={presentation.logoUrl}
                alt=""
                width={16}
                height={16}
                style={{ display: "block", objectFit: "contain" }}
              />
            ) : (
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
            )}
          </span>
          <div className="fl-approval-heading">
            <div className="fl-approval-eyebrow">{critical ? "CRITICAL" : presentation.eyebrow}</div>
            <div className="fl-approval-title">{presentation.title}</div>
          </div>
          <span
            className="fl-chip"
            data-risk={approval.descriptor.risk}
            title={approval.descriptor.name}
            style={{ marginLeft: "auto", padding: "2px 7px", fontSize: "10px", cursor: "default" }}
          >
            {approval.descriptor.risk}
          </span>
        </div>
        {presentation.description ? (
          <p className="fl-approval-desc">{presentation.description}</p>
        ) : null}
        {fields ? (
          <dl className="fl-approval-fields" aria-label="Real tool inputs" style={{ display: "grid", gap: "7px", margin: 0 }}>
            {fields.map(([key, value]) => (
              <div className="fl-approval-field" key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <pre
            className="fl-approval-fields"
            aria-label="Real tool inputs"
            style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          >
            {approval.inputPreview}
          </pre>
        )}
        <div className="fl-approval-more" style={{ marginTop: "8px" }}>
          Runs as you · {VENUE_LABEL[approval.ctx.venue] ?? approval.ctx.venue}
          {approval.ctx.appId ? ` · ${approval.ctx.appId}` : ""}
        </div>
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
