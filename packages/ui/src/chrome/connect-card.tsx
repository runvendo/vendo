import { useEffect, useRef, useState } from "react";
import { useVendoContext } from "../context.js";
import { ChromeRoot } from "./chrome-root.js";

export interface ConnectCardProps {
  connector: string;
  toolkit: string;
  message: string;
  /** Fired once the broker reports the account active — the thread retries the call. */
  onConnected(): void | PromiseLike<void>;
}

type Phase = "idle" | "connecting" | "connected" | "failed";

const POLL_INTERVAL_MS = 1_500;
const POLL_DEADLINE_MS = 120_000;

/** 04-actions §3 / 08-ui §4 — the inline connect card: a connector call ended
 * `connect-required`, so offer the broker's OAuth redirect in place, poll the
 * connection status while the user completes it, then retry the call. Follows
 * the approval-card pattern (same chrome, keyed to the same tool call). */
export function ConnectCard({ connector, toolkit, message, onConnected }: ConnectCardProps) {
  const { client } = useVendoContext();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string>();
  const cancelled = useRef(false);
  useEffect(() => () => {
    cancelled.current = true;
  }, []);

  const connect = async () => {
    setPhase("connecting");
    setError(undefined);
    try {
      const initiated = await client.connections.initiate({ toolkit, connector });
      // The broker's hosted OAuth flow runs in its own window; this page keeps
      // polling until the connection turns active.
      window.open(initiated.redirectUrl, "_blank", "noopener");
      const deadline = Date.now() + POLL_DEADLINE_MS;
      while (!cancelled.current && Date.now() < deadline) {
        const account = await client.connections
          .status(initiated.id, initiated.connector)
          .catch(() => undefined);
        if (account?.status === "active") {
          setPhase("connected");
          await onConnected();
          return;
        }
        if (account?.status === "failed" || account?.status === "expired") {
          throw new Error(`The ${toolkit} connection ${account.status} — try again.`);
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (!cancelled.current) throw new Error(`Timed out waiting for the ${toolkit} connection — try again.`);
    } catch (reason) {
      if (cancelled.current) return;
      setPhase("failed");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <ChromeRoot>
      <article className="fl-approval fl-item-in" aria-label={`Connect ${toolkit}`}>
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
              <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8" />
            </svg>
          </span>
          <div className="fl-approval-heading">
            <div className="fl-approval-eyebrow">CONNECT</div>
            <div className="fl-approval-title">{toolkit}</div>
          </div>
          <span
            className="fl-chip"
            style={{ marginLeft: "auto", padding: "2px 7px", fontSize: "10px", cursor: "default" }}
          >
            {connector}
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
                aria-label={`Connect ${toolkit}`}
                disabled={phase === "connecting"}
                onClick={() => void connect()}
              >
                {phase === "connecting" ? "Waiting for connection…" : `Connect ${toolkit}`}
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
