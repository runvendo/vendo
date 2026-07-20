import { useEffect, useRef, useState } from "react";
import { useVendoContext, type ConnectorOption } from "../context.js";
import { useConnections } from "../hooks/use-connections.js";
import { useConnectorCatalog } from "../hooks/use-connector-catalog.js";
import type { ConnectionAccount } from "../wire-types.js";
import { toolkitLogoUrl } from "./build-beat.js";
import { ChromeRoot } from "./chrome-root.js";
import { completeConnection } from "./connect-dock.js";
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
  const logo = toolkitLogoUrl(toolkit);
  return (
    <span className="fl-acct-logo" aria-hidden="true">
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element -- chrome surface, plain img by design
        <img src={logo} alt="" width={17} height={17} style={{ display: "block", objectFit: "contain" }} />
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8" />
        </svg>
      )}
    </span>
  );
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
  const { client } = useVendoContext();
  const { options: connectors } = useConnectorCatalog();
  const { connections, disconnect, refresh } = useConnections();
  const [confirming, setConfirming] = useState<Record<string, boolean>>({});
  const [severing, setSevering] = useState<Record<string, Severing | undefined>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string>();
  const timers = useRef(new Map<string, { commit: number; tick: number }>());
  // Pending disconnects flush on unmount (an undone-looking row must never
  // silently survive navigation), so the latest wire args live in a ref.
  const pendingRef = useRef(new Map<string, { connector: string }>());
  const cancelled = useRef(false);

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
        } catch (reason) {
          if (!cancelled.current) setError(reason instanceof Error ? reason.message : String(reason));
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

  // Connect-ahead runs through the host's connector catalog (context), so the
  // chips honour host labels and pinned broker connectors — never a hardcoded
  // toolkit list.
  const connectAhead = async (option: ConnectorOption) => {
    setError(undefined);
    setBusy(current => ({ ...current, [`connect-${option.toolkit}`]: true }));
    try {
      await completeConnection(client, { toolkit: option.toolkit, connector: option.connector }, () => cancelled.current);
      if (!cancelled.current) await refresh();
    } catch (reason) {
      if (!cancelled.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!cancelled.current) setBusy(current => ({ ...current, [`connect-${option.toolkit}`]: false }));
    }
  };

  return (
    <ChromeRoot>
      <section aria-labelledby="vendo-accounts-heading" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="vendo-accounts-heading" className="fl-auto-title" style={{ margin: 0 }}>Connected accounts</h2>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        {connections.length === 0 ? (
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
        {connections.map(connection => {
          const name = toolkitDisplayName(connection.toolkit);
          const status = STATUS[connection.status];
          const sever = severing[connection.id];
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
                <button
                  className="fl-btn"
                  type="button"
                  aria-label={`Disconnect ${name}`}
                  aria-expanded={confirming[connection.id] === true}
                  style={{ marginLeft: "auto" }}
                  onClick={() => setConfirming(current => ({ ...current, [connection.id]: !current[connection.id] }))}
                >Disconnect…</button>
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
