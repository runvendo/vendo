import { useEffect, useRef, useState } from "react";
import { useVendoProvider } from "../context.js";
import { useConnections } from "../hooks/use-connections.js";
import { useConnectorCatalog } from "../hooks/use-connector-catalog.js";
import { toolkitLogoUrl } from "./build-beat.js";
import {
  CardActions,
  CardHead,
  CardLine,
  CardShell,
  CARD_EYEBROWS,
  LINK_GLYPH,
  TICK_GLYPH,
  ToolkitLogo,
} from "./card-shell.js";
import { ChromeRoot } from "./chrome-root.js";
import { completeConnection, connectRefusalCopy, openConnectPopup } from "./connect-dock.js";
import { developmentMode } from "./dev-mode.js";
import { toolkitAccessCopy, toolkitDisplayName } from "./humanize.js";

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
  /** What connecting actually lets us do, in plain words ("read and send mail
   *  as you"). Defaults to the toolkit's entry in `toolkitAccessCopy`. Never an
   *  OAuth scope string — see that table. */
  access?: string;
  /** Fired when the person chooses "Not now". The card collapses to a one-line
   *  Skipped record that still offers Connect; the thread tells the agent so it
   *  can adapt instead of waiting. */
  onDeclined?(): void;
}

/** idle → the ask. connecting → the popup is open and the poll runs.
 *  popup-blocked → the browser refused the window; the SAME poll runs and the
 *  card offers the URL as a link. timed-out → the poll gave up, nothing
 *  changed. connected/skipped → the two settled records. failed → a refusal. */
type Phase = "idle" | "connecting" | "popup-blocked" | "timed-out" | "connected" | "skipped" | "failed";

/** 04-actions §3 / 08-ui §4 — the inline connect card: a connector call ended
 * `connect-required`, so offer the broker's OAuth redirect in place, poll the
 * connection status while the user completes it, then retry the call. Follows
 * the approval-card pattern (same chrome, keyed to the same tool call).
 * The initiate → OAuth window → poll-to-active loop is `completeConnection`,
 * shared with the connect dock (ENG-225).
 *
 * Brand-forward: the proper-case toolkit name (never the raw
 * slug), the toolkit's real mark in the icon well (link glyph fallback), and
 * an OAuth chip. The ask reads as the product, not the plumbing.
 *
 * 2026-07 demo feedback — the full lifecycle lives ON the card: a spinner-led
 * "Connecting…" button while the OAuth window is open, and a permanent quiet
 * "Connected" record once the broker reports the account active.
 *
 * V5 — the card is a consent surface, so it answers the three questions a
 * consent surface owes: what this grants (the plain-words access line, never a
 * scope string), what happens if you say no ("Not now", which records a Skipped
 * line that still re-offers), and what to do when the machinery gets in the way
 * (a blocked popup keeps polling behind a plain link; a timed-out poll says
 * nothing changed). */
export function ConnectCard({ connector, toolkit, message, onConnected, live = true, access, onDeclined }: ConnectCardProps) {
  const { client } = useVendoProvider();
  const { options: connectors } = useConnectorCatalog();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string>();
  // The broker's hosted OAuth URL, known as soon as `initiate` lands — the
  // blocked-popup fallback link needs it WHILE the poll runs.
  const [redirectUrl, setRedirectUrl] = useState<string>();
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
  const cancelled = useRef(false);
  useEffect(() => {
    // cancelled persists across effects; reset for StrictMode remounts.
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  // The host's catalog label wins when it named this toolkit (same rule as
  // the connect dock); otherwise the proper-cased toolkit.
  const option = connectors.find(candidate => candidate.toolkit === toolkit);
  const displayName = option?.label ?? toolkitDisplayName(toolkit);
  const accessCopy = access ?? toolkitAccessCopy(toolkit);

  const wireConnected = !live
    && connections.some(account => account.toolkit === toolkit && account.status === "active");
  const connected = phase === "connected" || wireConnected;
  // A stale ask that was never ANSWERED renders nothing — re-offering an old
  // connect is the persistent panel's job, not the transcript's. A card the
  // person answered with "Not now" is the exception: declining sends the agent
  // its continuation, which immediately makes this turn stale, so without this
  // the Skipped record blinks out the instant it appears.
  if (!live && !connected && phase !== "skipped") return null;

  const connect = async () => {
    // FIRST, before any await: a popup opened after one is blocked outright in
    // Safari and Firefox (openConnectPopup). A blocked window is not a dead end
    // — the same poll runs and the card offers the URL as a link instead.
    const popup = openConnectPopup(toolkit);
    setPhase(popup === null ? "popup-blocked" : "connecting");
    setError(undefined);
    setRedirectUrl(undefined);
    try {
      await completeConnection(client, { toolkit, connector }, () => cancelled.current, popup, setRedirectUrl);
      if (cancelled.current) return;
      setPhase("connected");
      await onConnected();
    } catch (reason) {
      if (cancelled.current) return;
      // A deadline is not a refusal: nobody said no, the wait simply ended.
      const timedOut = (reason as { code?: unknown } | null)?.code === "timeout";
      setPhase(timedOut ? "timed-out" : "failed");
      if (!timedOut) setError(connectRefusalCopy(reason, displayName));
      // Where a developer reads it: the host who forgot the connector needs the
      // sentence that names what to configure, and only they should see it.
      if (developmentMode()) {
        console.warn(`[vendo] ConnectCard "${toolkit}": ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    }
  };

  const decline = () => {
    setPhase("skipped");
    onDeclined?.();
  };

  // The one-line record of a declined ask. It still offers Connect: "not now"
  // is a moment's answer, not a standing one, and the ask is right there.
  if (phase === "skipped") {
    return (
      <ChromeRoot>
        <CardShell
          label={`Connect ${displayName}`}
          className="fl-approval fl-connect-skipped fl-item-in"
          data-vendo-connect-card="skipped"
        >
          <span className="fl-connect-skip-copy">Skipped — {displayName} isn’t connected</span>
          <button
            className="fl-btn fl-btn-quiet fl-connect-reoffer"
            type="button"
            aria-label={`Connect ${displayName}`}
            onClick={() => void connect()}
          >
            Connect
          </button>
        </CardShell>
      </ChromeRoot>
    );
  }

  const waiting = phase === "connecting" || phase === "popup-blocked";

  return (
    <ChromeRoot>
      <CardShell
        label={`Connect ${displayName}`}
        className="fl-approval fl-item-in"
        data-vendo-connect-card={connected ? "connected" : phase}
      >
        <CardHead
          icon={<ToolkitLogo src={toolkitLogoUrl(toolkit)} fallback={LINK_GLYPH} />}
          eyebrow={CARD_EYEBROWS.connect}
          title={displayName}
          aside={
            <span
              className="fl-chip"
              title={connector}
              style={{ marginLeft: "auto", padding: "2px 7px", fontSize: "10px", cursor: "default" }}
            >
              OAuth
            </span>
          }
        />
        <CardLine>{message}</CardLine>
        {/* What the person is actually agreeing to, in words — never the
            broker's scope strings (toolkitAccessCopy). */}
        {connected ? null : <CardLine className="fl-connect-access">Connecting lets us {accessCopy}.</CardLine>}
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        <CardActions>
          {connected ? (
            // The permanent record: the button becomes a quiet connected badge
            // — the card stays in the transcript as proof the account is live,
            // with the one line saying what that account can now do.
            <>
              <span role="status" className="fl-connect-done">
                <span className="fl-connect-done-ic" aria-hidden="true">{TICK_GLYPH}</span>
                Connected
              </span>
              <span className="fl-connect-receipt">We can now {accessCopy}.</span>
            </>
          ) : phase === "popup-blocked" ? (
            // The window never opened, but the connect did: the poll is running
            // on the same account, so the same URL in a tab finishes it.
            <div role="status" className="fl-connect-blocked">
              <span>Your browser blocked the sign-in window. Open it yourself — we’ll pick it up from here.</span>
              {redirectUrl === undefined ? null : (
                <a className="fl-btn fl-btn-primary" href={redirectUrl} target="_blank" rel="noreferrer">
                  Open sign-in in a new tab
                </a>
              )}
            </div>
          ) : phase === "timed-out" ? (
            <>
              <span role="status" className="fl-approval-more">Nothing changed — the sign-in never finished.</span>
              <button className="fl-btn fl-btn-primary" type="button" onClick={() => void connect()}>Try again</button>
            </>
          ) : (
            <>
              <button
                className="fl-btn fl-btn-primary"
                type="button"
                aria-label={`Connect ${displayName}`}
                disabled={waiting}
                onClick={() => void connect()}
              >
                {phase === "connecting" ? (
                  <>
                    <span className="fl-connect-spin" aria-hidden="true" />
                    Connecting…
                  </>
                ) : `Connect ${displayName}`}
              </button>
              {/* The other real answer. A stale card is a record, not an ask,
                  so it never offers one. */}
              {live && !waiting ? (
                <button className="fl-btn fl-btn-quiet" type="button" onClick={decline}>Not now</button>
              ) : null}
              {phase === "connecting" ? (
                <span role="status" className="fl-approval-more">
                  Finish signing in, then come back.
                  {waitedSeconds >= 3 ? ` Still waiting · ${waitedSeconds}s` : ""}
                </span>
              ) : null}
            </>
          )}
        </CardActions>
      </CardShell>
    </ChromeRoot>
  );
}
