import { useEffect, useRef, useState } from "react";
import { useVendoContext } from "../context.js";
import { ChromeRoot } from "./chrome-root.js";
import { completeConnection } from "./connect-dock.js";

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
 * shared with the connect dock (ENG-225). */
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
