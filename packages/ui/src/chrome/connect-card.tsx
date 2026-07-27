import { useEffect, useRef, useState } from "react";
import { useVendoContext } from "../context.js";
import { useConnections } from "../hooks/use-connections.js";
import { useConnectorCatalog } from "../hooks/use-connector-catalog.js";
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
  /**
   * Whether this card is still the actionable ask (it belongs to the LATEST
   * assistant turn). 2026-07 demo feedback — the card now STAYS in the
   * transcript after the moment passes: a stale card whose toolkit has an
   * active account renders the quiet Connected record; a stale card that was
   * never completed renders nothing (the old no-re-offer rule — the
   * persistent panel covers standing management). Default true.
   */
  live?: boolean;
}

type Phase = "idle" | "connecting" | "connected" | "failed";

const tick = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 12 4 4L19 6" />
  </svg>
);

/** 04-actions §3 / 08-ui §4 — the inline connect card: a connector call ended
 * `connect-required`, so offer the broker's OAuth redirect in place, poll the
 * connection status while the user completes it, then retry the call. Follows
 * the approval-card pattern (same chrome, keyed to the same tool call).
 * The initiate → OAuth window → poll-to-active loop is `completeConnection`,
 * shared with the connect dock (ENG-225).
 *
 * Lane pick 2-A — brand-forward: the proper-case toolkit name (never the raw
 * slug), the toolkit's real mark in the icon well (link glyph fallback), and
 * an OAuth chip. The ask reads as the product, not the plumbing.
 *
 * 2026-07 demo feedback — the full lifecycle lives ON the card: a spinner-led
 * "Connecting…" button while the OAuth window is open, and a permanent quiet
 * "Connected" record once the broker reports the account active. */
export function ConnectCard({ connector, toolkit, message, onConnected, live = true }: ConnectCardProps) {
  const { client } = useVendoContext();
  const { options: connectors } = useConnectorCatalog();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string>();
  // Stale cards (a past turn's ask) consult the wire: an active account for
  // this toolkit means the connect was completed — render the Connected
  // record so the transcript keeps the moment (it survives reload/restore).
  // One-shot fetch, no poll; live cards ignore the result — the server JUST
  // said connect-required, so the broker state is already known.
  const { connections } = useConnections();
  // 2026-07 loading-state audit — the OAuth wait can run a minute-plus while
  // the user signs in elsewhere; a quiet elapsed clock keeps the card honest
  // that it is still polling (reduced-motion readers keep the static hint).
  const [waitedSeconds, setWaitedSeconds] = useState(0);
  useEffect(() => {
    if (phase !== "connecting") {
      setWaitedSeconds(0);
      return;
    }
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setWaitedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1_000);
    return () => clearInterval(timer);
  }, [phase]);
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

  const wireConnected = !live
    && connections.some(account => account.toolkit === toolkit && account.status === "active");
  const connected = phase === "connected" || wireConnected;
  // A stale ask that was never completed renders nothing — re-offering an old
  // connect is the persistent panel's job, not the transcript's.
  if (!live && !connected) return null;

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
      <article className="fl-approval fl-item-in" aria-label={`Connect ${displayName}`} data-vendo-connect-card={connected ? "connected" : phase}>
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
          {connected ? (
            // The permanent record: the button becomes a quiet connected badge
            // — the card stays in the transcript as proof the account is live.
            <span role="status" className="fl-connect-done">
              <span className="fl-connect-done-ic" aria-hidden="true">{tick}</span>
              Connected
            </span>
          ) : (
            <>
              <button
                className="fl-btn fl-btn-primary"
                type="button"
                aria-label={`Connect ${displayName}`}
                disabled={phase === "connecting"}
                onClick={() => void connect()}
              >
                {phase === "connecting" ? (
                  <>
                    <span className="fl-connect-spin" aria-hidden="true" />
                    Connecting…
                  </>
                ) : `Connect ${displayName}`}
              </button>
              {phase === "connecting" ? (
                <span role="status" className="fl-approval-more">
                  Finish signing in, then come back.
                  {waitedSeconds >= 3 ? ` Still waiting · ${waitedSeconds}s` : ""}
                </span>
              ) : null}
            </>
          )}
        </div>
      </article>
    </ChromeRoot>
  );
}
