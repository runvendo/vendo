import { useEffect, useRef, useState } from "react";
import { useVendoProvider, type ConnectorOption } from "../context.js";
import { useConnections } from "../hooks/use-connections.js";
import { useConnectorCatalog } from "../hooks/use-connector-catalog.js";
import type { ConnectionAccount } from "../wire-types.js";
import { toolkitLogoUrl } from "./build-beat.js";
import { ChromeRoot } from "./chrome-root.js";
import { completeConnection, connectRefusalCopy, openConnectPopup } from "./connect-dock.js";
import { toolkitDisplayName } from "./humanize.js";

/** ui-lane-panels picks A + D + F — identity-forward rows, a two-step
 * disconnect with an undo window, and a connect-ahead empty state. */

function connectorDisplayName(connector: string): string {
  return connector === "composio" ? "Composio" : toolkitDisplayName(connector);
}

const STATUS: Record<ConnectionAccount["status"], { label: string; tone: "ok" | "warn" | "danger" | "off" }> = {
  active: { label: "Connected", tone: "ok" },
  initiated: { label: "Connecting…", tone: "off" },
  expired: { label: "Expired", tone: "warn" },
  failed: { label: "Failed", tone: "danger" },
};

function connectedDate(createdAt: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(createdAt));
}

function ToolkitMark({ toolkit }: { toolkit: string }) {
  // Same failure posture as the tray and connect card: a mark that fails to
  // load falls back to the link glyph instead of a broken-image icon.
  const [logoFailed, setLogoFailed] = useState(false);
  const logo = logoFailed ? undefined : toolkitLogoUrl(toolkit);
  return (
    <span className="fl-acct-logo" aria-hidden="true">
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element -- chrome surface, plain img by design
        <img src={logo} alt="" width={17} height={17} style={{ display: "block", objectFit: "contain" }} onError={() => setLogoFailed(true)} />
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8" />
        </svg>
      )}
    </span>
  );
}

const refusalCode = (reason: unknown): unknown => (reason as { code?: unknown } | null)?.code;

/** The broker answers not-found for any id outside the caller's own scope
 *  (`ConnectorConnections`' frozen rule), so this is the account ALREADY being
 *  gone — the person's intent, achieved. The row on screen is the stale half. */
const alreadyGone = (reason: unknown): boolean => refusalCode(reason) === "not-found";

/** The disconnect half of `connectRefusalCopy`. A refused disconnect leaves the
 *  account connected — but only some of these clear on their own, and "try
 *  again in a moment" sends the rest back to the same wall forever. */
function disconnectRefusalCopy(reason: unknown, name: string): string {
  const code = refusalCode(reason);
  // The person can act, just not from here as they are.
  if (code === "blocked") return `Sign in first, then disconnect ${name}.`;
  if (code === "forbidden") return `You don’t have access to disconnect ${name} here.`;
  // Nothing is behind the button on this deployment — no broker configured, or
  // Cloud standing lapsed. No number of retries reaches it.
  if (code === "not-implemented" || code === "cloud-required") {
    return `Disconnecting ${name} isn’t set up here — there’s nothing you can do from this screen.`;
  }
  // Everything else: broker 5xx, timeouts, a dropped request — and `validation`,
  // which the client also stamps on any envelope carrying no code of its own,
  // so it is the unknown bucket rather than a verdict about the deployment.
  return `We couldn’t disconnect ${name} — it is still connected. Try again in a moment.`;
}

interface Severing {
  /** Seconds left on the undo window (display only). */
  left: number;
}

export interface ConnectedAccountsPanelProps {
  /** The undo window (ms) between confirming a disconnect and the wire call
   *  actually firing. Undo inside the window cancels; navigating away flushes
   *  the pending disconnect immediately. Default 10s. */
  undoMs?: number;
}

/** 04-actions §3 / 08-ui §4 — the persistent connected-accounts settings
 * surface: every external account the signed-in user has connected through
 * the broker, with real service identity (logo, display name, status chip)
 * and a consequence-aware, reversible disconnect. Connecting normally happens
 * in-flow (the connect card); the empty state additionally offers connecting
 * ahead of time via the same broker redirect. */
export function ConnectedAccountsPanel({ undoMs = 10_000 }: ConnectedAccountsPanelProps = {}) {
  const { client } = useVendoProvider();
  const { options: connectors } = useConnectorCatalog();
  const { connections, disconnect, refresh } = useConnections();
  const [confirming, setConfirming] = useState<Record<string, boolean>>({});
  const [severing, setSevering] = useState<Record<string, Severing | undefined>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string>();
  // Connects whose sign-in window the browser refused, keyed like `busy` — the
  // buttons disable per key, so two can run at once, and a shared notice would
  // let the second connect erase a link the first still needs. `url` is the
  // broker's own redirect, known only once initiate lands: the fallback link
  // needs it WHILE the poll runs.
  const [blocked, setBlocked] = useState<Record<string, { name: string; url?: string } | undefined>>({});
  // Accounts the WIRE has confirmed gone. The list read that follows a sever is
  // not what proves it: `useResource` keeps its last good page when a refresh
  // fails, which would put the row back wearing a Connected chip.
  const [severed, setSevered] = useState<Record<string, boolean>>({});
  const timers = useRef(new Map<string, { commit: number; tick: number }>());
  // Pending disconnects flush on unmount (an undone-looking row must never
  // silently survive navigation), so the latest wire args live in a ref.
  const pendingRef = useRef(new Map<string, { connector: string }>());
  const cancelled = useRef(false);

  // …and never permanently. `not-found` is also what the composition throws
  // when the CONNECTOR is missing rather than the account, and the client
  // cannot tell those apart — so a list read the server actually ANSWERS
  // overrules the sever: an account still on that page is live, whatever the
  // disconnect said. `useResource` replaces this array only on a successful
  // read, so a failed refresh never reaches here and the row stays gone.
  useEffect(() => {
    setSevered(current => {
      const kept = Object.keys(current).filter(id => !connections.some(row => row.id === id));
      return kept.length === Object.keys(current).length
        ? current
        : Object.fromEntries(kept.map(id => [id, true]));
    });
  }, [connections]);

  // The unmount flush must see the CURRENT disconnect without re-running the
  // effect (an effect keyed on `disconnect` would flush pending severs on any
  // identity change mid-session).
  const disconnectRef = useRef(disconnect);
  disconnectRef.current = disconnect;
  useEffect(() => {
    // cancelled/pending state persists across effects; reset for StrictMode remounts.
    cancelled.current = false;
    const pending = pendingRef.current;
    const active = timers.current;
    return () => {
      cancelled.current = true;
      for (const timer of active.values()) {
        window.clearTimeout(timer.commit);
        window.clearInterval(timer.tick);
      }
      active.clear();
      for (const [id, { connector }] of pending) {
        void disconnectRef.current(id, connector).catch(() => undefined);
      }
      pending.clear();
    };
  }, []);

  const clearTimers = (id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      window.clearTimeout(timer.commit);
      window.clearInterval(timer.tick);
      timers.current.delete(id);
    }
  };

  const beginSever = (connection: ConnectionAccount) => {
    const id = connection.id;
    setConfirming(current => ({ ...current, [id]: false }));
    setSevering(current => ({ ...current, [id]: { left: Math.max(1, Math.ceil(undoMs / 1000)) } }));
    pendingRef.current.set(id, { connector: connection.connector });
    const tick = window.setInterval(() => {
      setSevering(current => {
        const entry = current[id];
        if (!entry) return current;
        return { ...current, [id]: { left: Math.max(0, entry.left - 1) } };
      });
    }, 1_000);
    const commit = window.setTimeout(() => {
      clearTimers(id);
      pendingRef.current.delete(id);
      void (async () => {
        setError(undefined);
        setBusy(current => ({ ...current, [id]: true }));
        try {
          await disconnect(id, connection.connector);
          if (!cancelled.current) setSevered(current => ({ ...current, [id]: true }));
        } catch (reason) {
          // spec §16 law 3 — the wire's sentence is the developer's; the person
          // gets ours, and it names the refusal rather than a blanket retry.
          // An account that is already gone is not a failure to report: the
          // broker answers not-found for anything outside the caller's own
          // scope, so the sever is a fact and only the row is stale.
          if (cancelled.current) return;
          if (alreadyGone(reason)) {
            setSevered(current => ({ ...current, [id]: true }));
            // The row is already gone from the page, so this read is not what
            // proves it — it is the check on the claim. A successful one that
            // still has the account brings it back (see the effect above); a
            // failed one changes nothing.
            await refresh();
          } else setError(disconnectRefusalCopy(reason, toolkitDisplayName(connection.toolkit)));
        } finally {
          if (!cancelled.current) {
            setBusy(current => ({ ...current, [id]: false }));
            setSevering(current => ({ ...current, [id]: undefined }));
          }
        }
      })();
    }, undoMs);
    timers.current.set(id, { commit, tick });
  };

  const undoSever = (id: string) => {
    clearTimers(id);
    pendingRef.current.delete(id);
    setSevering(current => ({ ...current, [id]: undefined }));
  };

  /**
   * The panel's one connect: the same initiate → sign-in window → poll-to-active
   * flow the connect card runs, then a refresh so the account settles into the
   * Connected chip.
   *
   * The window opens FIRST, synchronously inside the click (`openConnectPopup`).
   * Both callers used to hand `completeConnection` no window at all, which left
   * it opening one after the initiate await — the post-await shape Safari and
   * Firefox refuse by call-stack provenance, so the button did nothing at all.
   * A window the browser refuses anyway is not a dead end either: the connect is
   * initiated and the poll is running, so `blocked` offers the broker's URL as a
   * plain link and finishing there settles the row as normal.
   */
  const connect = async (key: string, name: string, input: { toolkit: string; connector?: string }) => {
    const popup = openConnectPopup();
    const clearBlocked = () => setBlocked(current => ({ ...current, [key]: undefined }));
    setError(undefined);
    setBlocked(current => ({ ...current, [key]: popup === null ? { name } : undefined }));
    setBusy(current => ({ ...current, [key]: true }));
    try {
      await completeConnection(client, input, () => cancelled.current, popup, url => {
        if (popup === null && !cancelled.current) setBlocked(current => ({ ...current, [key]: { name, url } }));
      });
      if (cancelled.current) return;
      clearBlocked();
      await refresh();
    } catch (reason) {
      if (!cancelled.current) {
        // This connect is over, so its link is stale — a fresh initiate is what a
        // retry needs, and the refusal copy says so. Only THIS key clears: a
        // sibling connect may still be waiting on its own sign-in.
        clearBlocked();
        setError(connectRefusalCopy(reason, name));
      }
    } finally {
      if (!cancelled.current) setBusy(current => ({ ...current, [key]: false }));
    }
  };

  // Demo-hygiene: a non-active row leads with a single obvious repair.
  const reconnect = (connection: ConnectionAccount) => connect(
    `reconnect-${connection.id}`,
    toolkitDisplayName(connection.toolkit),
    { toolkit: connection.toolkit, connector: connection.connector },
  );

  // Connect-ahead runs through the host's connector catalog (context), so the
  // chips honour host labels and pinned broker connectors — never a hardcoded
  // toolkit list.
  const connectAhead = (option: ConnectorOption) => connect(
    `connect-${option.toolkit}`,
    option.label ?? toolkitDisplayName(option.toolkit),
    { toolkit: option.toolkit, connector: option.connector },
  );

  const rows = connections.filter(connection => severed[connection.id] !== true);

  return (
    <ChromeRoot>
      <section aria-labelledby="vendo-accounts-heading" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="vendo-accounts-heading" className="fl-auto-title" style={{ margin: 0 }}>Connected accounts</h2>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        {Object.entries(blocked).map(([key, entry]) => entry === undefined ? null : (
          // The window never opened, but the connect did: the poll is running on
          // that account, so the same URL in a tab finishes it. One notice per
          // connect still waiting — each names its own service.
          <div key={key} role="status" className="fl-connect-blocked">
            <span>Your browser blocked the {entry.name} sign-in window. Open it yourself — we’ll pick it up from here.</span>
            {entry.url === undefined ? null : (
              <a className="fl-btn fl-btn-primary" href={entry.url} target="_blank" rel="noreferrer">
                Open sign-in in a new tab
              </a>
            )}
          </div>
        ))}
        {rows.length === 0 ? (
          <div className="fl-acct-ghost">
            <span className="fl-acct-ghost-title">No connected accounts yet</span>
            <p className="fl-acct-ghost-copy">
              Normally you’ll connect an account right in the conversation, the moment the agent needs
              it.{connectors.length > 0 ? " If you’d rather set one up ahead of time:" : ""}
            </p>
            {connectors.length > 0 ? (
              <div className="fl-acct-connect-row">
                {connectors.map(option => {
                  const label = option.label ?? toolkitDisplayName(option.toolkit);
                  return (
                    <button
                      key={option.toolkit}
                      className="fl-acct-connect-chip"
                      type="button"
                      disabled={busy[`connect-${option.toolkit}`] === true}
                      onClick={() => void connectAhead(option)}
                    >
                      <ToolkitMark toolkit={option.toolkit} />
                      <span>{busy[`connect-${option.toolkit}`] ? "Connecting…" : `Connect ${label}`}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        {rows.map(connection => {
          const name = toolkitDisplayName(connection.toolkit);
          const status = STATUS[connection.status];
          const sever = severing[connection.id];
          // Expired/failed rows lead with Reconnect (primary); Disconnect
          // demotes to a quiet secondary. Active/initiated rows are unchanged.
          const repairable = connection.status === "expired" || connection.status === "failed";
          const reconnecting = busy[`reconnect-${connection.id}`] === true;
          if (sever) {
            return (
              <div className="fl-acct-severed" key={`${connection.connector}-${connection.id}`} role="status">
                <ToolkitMark toolkit={connection.toolkit} />
                <span>{name} disconnected — standing access severed.</span>
                <span className="fl-acct-undo">
                  <span className="fl-acct-undo-count">{sever.left > 0 ? `${sever.left}s` : "…"}</span>
                  <button
                    className="fl-btn"
                    type="button"
                    disabled={busy[connection.id] === true || sever.left <= 0}
                    onClick={() => undoSever(connection.id)}
                  >Undo</button>
                </span>
              </div>
            );
          }
          return (
            <article className="fl-automation" key={`${connection.connector}-${connection.id}`}>
              <div className="fl-auto-head">
                <ToolkitMark toolkit={connection.toolkit} />
                <div>
                  <div className="fl-auto-title fl-acct-title">
                    {name}
                    <span className={`fl-acct-chip fl-acct-chip--${status.tone}`}>
                      <i aria-hidden="true" />
                      {status.label}
                    </span>
                  </div>
                  <div className="fl-auto-sub">
                    {`via ${connectorDisplayName(connection.connector)}`}
                    {connection.createdAt ? ` · connected ${connectedDate(connection.createdAt)}` : ""}
                  </div>
                </div>
                <span className="fl-acct-actions">
                  {repairable ? (
                    <button
                      className="fl-btn fl-btn-primary"
                      type="button"
                      aria-label={`Reconnect ${name}`}
                      disabled={reconnecting}
                      onClick={() => void reconnect(connection)}
                    >
                      {reconnecting ? (
                        <span className="fl-btn-spin" aria-hidden="true" />
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                          <path d="M21 3v5h-5" />
                          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                          <path d="M3 21v-5h5" />
                        </svg>
                      )}
                      {reconnecting ? "Reconnecting…" : "Reconnect"}
                    </button>
                  ) : null}
                  <button
                    className={repairable ? "fl-btn fl-btn-quiet" : "fl-btn"}
                    type="button"
                    aria-label={`Disconnect ${name}`}
                    aria-expanded={confirming[connection.id] === true}
                    onClick={() => setConfirming(current => ({ ...current, [connection.id]: !current[connection.id] }))}
                  >Disconnect…</button>
                </span>
              </div>
              <div className={`fl-acct-confirm${confirming[connection.id] ? " fl-acct-confirm--open" : ""}`}>
                <div className="fl-acct-confirm-inner">
                  <span>
                    <b>{`Disconnect ${name}?`}</b>
                    <span className="fl-acct-confirm-sub">
                      {`Vendo loses the ability to act in ${name} as you. Anything that posts through this account pauses until you reconnect.`}
                    </span>
                  </span>
                  <span className="fl-acct-confirm-actions">
                    <button
                      className="fl-btn fl-btn-ceremony"
                      type="button"
                      onClick={() => beginSever(connection)}
                    >Disconnect</button>
                    <button
                      className="fl-btn"
                      type="button"
                      onClick={() => setConfirming(current => ({ ...current, [connection.id]: false }))}
                    >Keep</button>
                  </span>
                </div>
              </div>
            </article>
          );
        })}
      </section>
    </ChromeRoot>
  );
}
