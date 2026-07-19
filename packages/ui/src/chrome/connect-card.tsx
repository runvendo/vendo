import { useEffect, useRef, useState } from "react";
import { useVendoContext } from "../context.js";
import { toolkitLogoUrl } from "./build-beat.js";
import { ChromeRoot } from "./chrome-root.js";
import { completeConnection } from "./connect-dock.js";
import { toolkitDisplayName } from "./humanize.js";

export interface ConnectCardProps {
  connector: string;
  toolkit: string;
  message: string;
  /** Fired once the broker reports the account active — the thread retries the call. */
  onConnected(): void | PromiseLike<void>;
}

type Phase = "idle" | "connecting" | "connected" | "failed";

/** 04-actions §3 / 08-ui §4 — the inline connect card: a connector call ended
 * `connect-required`, so offer the broker's OAuth redirect in place, poll the
 * connection status while the user completes it, then retry the call. Follows
 * the approval-card pattern (same chrome, keyed to the same tool call).
 * The initiate → OAuth window → poll-to-active loop is `completeConnection`,
 * shared with the connect dock (ENG-225).
 *
 * Lane pick 2-A — brand-forward: the proper-case toolkit name (never the raw
 * slug), the toolkit's real mark in the icon well (link glyph fallback), and
 * an OAuth chip. The ask reads as the product, not the plumbing. */
export function ConnectCard({ connector, toolkit, message, onConnected }: ConnectCardProps) {
  const { client, connectors } = useVendoContext();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string>();
  // Keyed to the toolkit so a failed mark for one toolkit never suppresses
  // branding after the prop changes.
  const [logoFailedFor, setLogoFailedFor] = useState<string>();
  const cancelled = useRef(false);
  useEffect(() => () => {
    cancelled.current = true;
  }, []);

  // The host's catalog label wins when it named this toolkit (same rule as
  // the connect dock); otherwise the proper-cased toolkit.
  const option = connectors.find(candidate => candidate.toolkit === toolkit);
  const displayName = option?.label ?? toolkitDisplayName(toolkit);
  const logoUrl = logoFailedFor === toolkit ? undefined : toolkitLogoUrl(toolkit);

  const connect = async () => {
    setPhase("connecting");
    setError(undefined);
    try {
      await completeConnection(client, { toolkit, connector }, () => cancelled.current);
      if (cancelled.current) return;
      setPhase("connected");
      await onConnected();
    } catch (reason) {
      if (cancelled.current) return;
      setPhase("failed");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <ChromeRoot>
      <article className="fl-approval fl-item-in" aria-label={`Connect ${displayName}`}>
        <div className="fl-approval-head">
          <span className="fl-approval-ic" aria-hidden="true">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- chrome surface, plain img by design
              <img
                src={logoUrl}
                alt=""
                width={16}
                height={16}
                style={{ display: "block", objectFit: "contain" }}
                onError={() => setLogoFailedFor(toolkit)}
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
                <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8" />
              </svg>
            )}
          </span>
          <div className="fl-approval-heading">
            <div className="fl-approval-eyebrow">CONNECT</div>
            <div className="fl-approval-title">{displayName}</div>
          </div>
          <span
            className="fl-chip"
            title={connector}
            style={{ marginLeft: "auto", padding: "2px 7px", fontSize: "10px", cursor: "default" }}
          >
            OAuth
          </span>
        </div>
        <p className="fl-approval-more" style={{ marginTop: "8px" }}>{message}</p>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        <div className="fl-approval-actions">
          {phase === "connected" ? (
            <span role="status" className="fl-approval-more">Connected — retrying…</span>
          ) : (
            <>
              <button
                className="fl-btn fl-btn-primary"
                type="button"
                aria-label={`Connect ${displayName}`}
                disabled={phase === "connecting"}
                onClick={() => void connect()}
              >
                {phase === "connecting" ? "Waiting for connection…" : `Connect ${displayName}`}
              </button>
              {phase === "connecting" ? (
                <span role="status" className="fl-approval-more">Finish signing in, then come back.</span>
              ) : null}
            </>
          )}
        </div>
      </article>
    </ChromeRoot>
  );
}
