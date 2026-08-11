import { log } from "@vendoai/core";
import { useEffect, useRef, useState } from "react";
import { useVendoProvider } from "../context.js";
import { useConnections } from "../hooks/use-connections.js";
import { useConnectorCatalog } from "../hooks/use-connector-catalog.js";
import { toolkitLogoUrl } from "./build-beat.js";
import { CardShell, LINK_GLYPH, TICK_GLYPH, ToolkitLogo } from "./card-shell.js";
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

/** One item of the dot-joined line, which carries FRAGMENTS rather than
    sentences: its two copy sources are written as a full sentence (the model's
    message) and as a sentence body (`toolkitAccessCopy`: "read and send mail as
    you"), so one loses its full stop and the other gains its capital. */
const fragment = (copy: string): string =>
  copy.charAt(0).toUpperCase() + copy.slice(1).replace(/\.$/, "");

/** 04-actions §3 / 08-ui §4 — the inline connect card: a connector call ended
 * `connect-required`, so offer the broker's OAuth redirect in place, poll the
 * connection status while the user completes it, then retry the call. Follows
 * the approval-card pattern (same chrome, keyed to the same tool call).
 * The initiate → OAuth window → poll-to-active loop is `completeConnection`,
 * shared with the connect dock (ENG-225).
 *
 * C2 · Integration row — the sentence family the approval card opened: the
 * toolkit's RAW mark (no well — a 28px well with a radius cropped the Gmail M),
 * the proper-case name (never the raw slug), ONE quiet line carrying why we are
 * asking and what connecting grants, and one button. The eyebrow, the icon well
 * and the OAuth chip are gone; what the chip said rides that line as words.
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
        log({
          code: "ui.connect-card-failed",
          level: "warn",
          message: `[vendo] ConnectCard "${toolkit}": ${reason instanceof Error ? reason.message : String(reason)}`,
        });
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

  // The one quiet line, in the order a person asks it: why we need this (the
  // model's own sentence), what connecting grants in plain words (never a scope
  // string), and how it is secured — the three facts the retired message line,
  // access line and OAuth chip carried between them. Settled, the same line
  // becomes the receipt of what the account can now do.
  const notes = connected
    ? [`We can now ${accessCopy}.`]
    : [fragment(message), fragment(accessCopy), "Secured with OAuth"];

  // Every phase says what it is doing in ONE status voice under the row, so a
  // screen reader has exactly one live region per state to read. The blocked
  // phase carries its recovery link INSIDE that region, under the sentence that
  // explains it: an "Open sign-in in a new tab" button reached before the words
  // "your browser blocked the sign-in window" is an instruction with no reason.
  const status = connected || phase === "idle" || phase === "failed" ? null : (
    <div role="status" className={phase === "popup-blocked" ? "fl-connect-blocked fl-connect-note" : "fl-approval-more fl-connect-note"}>
      {phase === "connecting" ? (
        `Finish signing in, then come back.${waitedSeconds >= 3 ? ` Still waiting · ${waitedSeconds}s` : ""}`
      ) : phase === "popup-blocked" ? (
        <>
          {/* The window never opened, but the connect did: the poll is running
              on the same account, so the same URL in a tab finishes it. */}
          <span>Your browser blocked the sign-in window. Open it yourself — we’ll pick it up from here.</span>
          {redirectUrl === undefined ? null : (
            <a className="fl-btn fl-btn-primary" href={redirectUrl} target="_blank" rel="noreferrer">
              Open sign-in in a new tab
            </a>
          )}
        </>
      ) : "Nothing changed — the sign-in never finished."}
    </div>
  );

  return (
    <ChromeRoot>
      <CardShell
        label={`Connect ${displayName}`}
        className="fl-approval fl-item-in"
        data-vendo-connect-card={connected ? "connected" : phase}
      >
        <div className="fl-connect-row">
          {/* RAW, at its own aspect ratio: the 28px well cropped the Gmail M. */}
          <ToolkitLogo src={toolkitLogoUrl(toolkit)} fallback={LINK_GLYPH} className="fl-mark-raw" />
          <div className="fl-connect-copy">
            <div className="fl-connect-name">{displayName}</div>
            {/* Law 3's line, drawn the way the approval card draws its notes:
                ONE line to the eye, a LIST to a screen reader, with the " · "
                between items in CSS so it is never announced. Named for what it
                holds: the ask's terms before, the account's receipt after. */}
            <ul
              className="fl-card-line fl-approval-sub"
              aria-label={connected ? `What ${displayName} can now do` : `What connecting ${displayName} does`}
            >
              {notes.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          </div>
          <div className="fl-connect-act">
            {connected ? (
              // The permanent record: the button becomes a quiet connected badge
              // — the card stays in the transcript as proof the account is live,
              // and the line above says what that account can now do.
              <span role="status" className="fl-connect-done">
                <span className="fl-connect-done-ic" aria-hidden="true">{TICK_GLYPH}</span>
                Connected
              </span>
            ) : phase === "popup-blocked" ? (
              // The recovery link rides the status region below, under the
              // sentence that explains why it is there.
              null
            ) : phase === "timed-out" ? (
              <button className="fl-btn fl-btn-primary" type="button" onClick={() => void connect()}>Try again</button>
            ) : (
              <>
                <button
                  className="fl-btn fl-btn-primary"
                  type="button"
                  // The name carries the toolkit even though the label is one
                  // word: the row already says Gmail, a screen reader's button
                  // list does not.
                  aria-label={`Connect ${displayName}`}
                  disabled={waiting}
                  onClick={() => void connect()}
                >
                  {phase === "connecting" ? (
                    <>
                      <span className="fl-connect-spin" aria-hidden="true" />
                      Connecting…
                    </>
                  ) : "Connect"}
                </button>
                {/* The other real answer. A stale card is a record, not an ask,
                    so it never offers one. */}
                {live && !waiting ? (
                  <button className="fl-btn fl-btn-quiet" type="button" onClick={decline}>Not now</button>
                ) : null}
              </>
            )}
          </div>
        </div>
        {status}
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
      </CardShell>
    </ChromeRoot>
  );
}
