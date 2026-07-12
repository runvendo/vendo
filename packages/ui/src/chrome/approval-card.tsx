import { canonicalJson, sha256Hex, type ApprovalDecision, type ApprovalRequest } from "@vendoai/core";
import { useState } from "react";
import { ChromeRoot } from "./chrome-root.js";

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

/** 01-core §5; 08-ui §4 — the one consent surface, always showing real inputs. */
export function ApprovalCard({ approval, onDecide, allowRemember = true }: ApprovalCardProps) {
  const [remember, setRemember] = useState(false);
  const [scope, setScope] = useState<"exact" | "tool">("exact");
  const [duration, setDuration] = useState<"session" | "standing">("session");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

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
      <article className="vendo-card vendo-approval vendo-stack" aria-label={`Approval for ${approval.descriptor.name}`}>
        <div className="vendo-row">
          <strong>{approval.descriptor.name}</strong>
          <span className="vendo-chip" data-risk={approval.descriptor.risk}>{approval.descriptor.risk}</span>
        </div>
        <pre className="vendo-approval-preview" aria-label="Real tool inputs">{approval.inputPreview}</pre>
        <div className="vendo-muted">
          {approval.ctx.venue} · {approval.ctx.presence}
          {approval.ctx.appId ? ` · ${approval.ctx.appId}` : ""}
        </div>
        {allowRemember ? (
        <details>
          <summary>Remember this decision</summary>
          <label className="vendo-row">
            <input
              type="checkbox"
              checked={remember}
              onChange={event => setRemember(event.currentTarget.checked)}
            />
            Create a reusable grant when approved
          </label>
          <fieldset disabled={!remember}>
            <legend>Scope</legend>
            <label className="vendo-row"><input type="radio" name={`scope-${approval.id}`} checked={scope === "exact"} onChange={() => setScope("exact")} />This exact input</label>
            <label className="vendo-row"><input type="radio" name={`scope-${approval.id}`} checked={scope === "tool"} onChange={() => setScope("tool")} />The whole tool</label>
          </fieldset>
          <fieldset disabled={!remember}>
            <legend>Duration</legend>
            <label className="vendo-row"><input type="radio" name={`duration-${approval.id}`} checked={duration === "session"} onChange={() => setDuration("session")} />This session</label>
            <label className="vendo-row"><input type="radio" name={`duration-${approval.id}`} checked={duration === "standing"} onChange={() => setDuration("standing")} />Standing</label>
          </fieldset>
        </details>
        ) : null}
        {error ? <div role="alert" className="vendo-danger">{error}</div> : null}
        <div className="vendo-row">
          <button className="vendo-primary" type="button" disabled={busy} onClick={() => void decide(true)}>Approve</button>
          <button className="vendo-danger" type="button" disabled={busy} onClick={() => void decide(false)}>Deny</button>
        </div>
      </article>
    </ChromeRoot>
  );
}
