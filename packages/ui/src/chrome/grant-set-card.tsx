import type { RiskLabel } from "@vendoai/core";
import { useState } from "react";
import { useVendoTools } from "../context.js";
import { toolPresentation } from "./build-beat.js";
import { ChromeRoot } from "./chrome-root.js";

/** demo-live-readiness 2026-07 — the grant-SET consent card (approved mockup,
 * section 2): an automation that needs several standing grants asks for ALL of
 * them in one card — every permission enumerated, ONE Approve that grants the
 * whole set, one Deny that declines it. The decided card stays in the
 * transcript as the settled record ("Enabled · N permissions granted" /
 * "Denied — the automation stays paused."). Presentational: the caller owns
 * deciding the guard approvals and resuming the parked turn.
 */

export interface GrantSetPermission {
  /** The pending guard approval this row settles. */
  approvalId: string;
  tool: string;
  /** The tool descriptor's one-line description. */
  description?: string;
  risk: RiskLabel;
}

export interface GrantSetCardProps {
  /** The automation's display name. */
  name: string;
  permissions: GrantSetPermission[];
  /** parked → actionable; approved/denied → the settled record. */
  state: "parked" | "approved" | "denied";
  onDecide?(approve: boolean): void | PromiseLike<void>;
}

const permissionCount = (count: number): string => count === 1 ? "1 permission" : `${count} permissions`;

/** Mockup copy: "Allow both & enable" for the pair; sensible words either side. */
export function allowLabel(count: number): string {
  if (count === 1) return "Allow & enable";
  if (count === 2) return "Allow both & enable";
  return `Allow all ${count} & enable`;
}

const revokePronoun = (count: number): string =>
  count === 1 ? "it" : count === 2 ? "either" : "any of them";

export function GrantSetCard({ name, permissions, state, onDecide }: GrantSetCardProps) {
  const tools = useVendoTools();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const decide = async (approve: boolean) => {
    if (onDecide === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await onDecide(approve);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ChromeRoot>
      <article
        className="fl-approval fl-grantset fl-item-in"
        data-vendo-grant-set-card=""
        data-state={state}
        aria-label={`Standing access — ${name}`}
      >
        <div className="fl-approval-head">
          <span className="fl-approval-ic" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            </svg>
          </span>
          <div className="fl-approval-heading">
            <div className="fl-approval-eyebrow">Standing access</div>
            <div className="fl-approval-title">{name} needs {permissionCount(permissions.length)}</div>
            <div className="fl-approval-desc" style={{ marginTop: 3 }}>
              Granted once, used every run. You can revoke {revokePronoun(permissions.length)} any time in Settings.
            </div>
          </div>
        </div>
        <ul className="fl-grants">
          {permissions.map(permission => {
            const presentation = toolPresentation(permission.tool, undefined, tools[permission.tool]);
            const description = (presentation.description ?? permission.description ?? "").trim();
            return (
              <li className="fl-grant" key={permission.approvalId}>
                <span className="fl-grant-ic" aria-hidden="true">
                  {presentation.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- chrome surface, plain img by design
                    <img src={presentation.logoUrl} alt="" width={14} height={14} style={{ display: "block", objectFit: "contain" }} />
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m21 2-9.6 9.6" /><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-1 1" /><path d="m15.5 7.5 3 3L22 7l-3-3" />
                    </svg>
                  )}
                </span>
                <span className="fl-grant-copy">
                  <b>{presentation.title}</b>
                  {description.length > 0 ? <span>{description}</span> : null}
                </span>
                {state === "approved" ? (
                  <span className="fl-grant-check" aria-hidden="true">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        {state === "parked" ? (
          <div className="fl-approval-actions">
            <button className="fl-btn fl-btn-primary" type="button" disabled={busy} onClick={() => void decide(true)}>
              {allowLabel(permissions.length)}
            </button>
            <button className="fl-btn" type="button" disabled={busy} onClick={() => void decide(false)}>Deny</button>
          </div>
        ) : (
          <div className="fl-grantset-outcome" role="status">
            {state === "approved" ? (
              <>
                <span className="fl-connect-done-ic" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </span>
                Enabled · {permissionCount(permissions.length)} granted
              </>
            ) : (
              <>Denied — the automation stays paused.</>
            )}
          </div>
        )}
      </article>
    </ChromeRoot>
  );
}
