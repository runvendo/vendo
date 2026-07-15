import { useState } from "react";
import { useConnections } from "../hooks/use-connections.js";
import { ChromeRoot } from "./chrome-root.js";

function statusLabel(status: "initiated" | "active" | "expired" | "failed"): string {
  if (status === "active") return "Connected";
  if (status === "initiated") return "Connecting…";
  if (status === "expired") return "Expired — reconnect from a conversation";
  return "Failed";
}

function connectedDate(createdAt: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(createdAt));
}

/** 04-actions §3 / 08-ui §4 — the persistent connected-accounts settings
 * surface: every external account the signed-in user has connected through
 * the broker, with disconnect. Connecting happens in-flow (the connect card);
 * this panel is where users see and sever standing access. */
export function ConnectedAccountsPanel() {
  const { connections, disconnect } = useConnections();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string>();

  const sever = async (id: string, connector: string) => {
    setError(undefined);
    setBusy(current => ({ ...current, [id]: true }));
    try {
      await disconnect(id, connector);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(current => ({ ...current, [id]: false }));
    }
  };

  return (
    <ChromeRoot>
      <section aria-labelledby="vendo-accounts-heading" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="vendo-accounts-heading" className="fl-auto-title" style={{ margin: 0 }}>Connected accounts</h2>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        {connections.length === 0 ? (
          <p className="fl-auto-sub" style={{ margin: 0 }}>
            No connected accounts yet. When a conversation needs one, you’ll connect it right in the thread.
          </p>
        ) : null}
        {connections.map(connection => (
          <article className="fl-automation" key={`${connection.connector}-${connection.id}`}>
            <div className="fl-auto-head">
              <span className="fl-auto-ic" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8" />
                </svg>
              </span>
              <div>
                <div className="fl-auto-title">{connection.toolkit}</div>
                <div className="fl-auto-sub">
                  {connection.status === "active" ? <span className="fl-auto-live" aria-hidden="true" /> : null}
                  {statusLabel(connection.status)}
                  {connection.createdAt ? ` · since ${connectedDate(connection.createdAt)}` : ""}
                  {` · via ${connection.connector}`}
                </div>
              </div>
              <button
                className="fl-btn fl-btn-ceremony"
                type="button"
                aria-label={`Disconnect ${connection.toolkit}`}
                disabled={busy[connection.id] === true}
                style={{ marginLeft: "auto" }}
                onClick={() => void sever(connection.id, connection.connector)}
              >Disconnect</button>
            </div>
          </article>
        ))}
      </section>
    </ChromeRoot>
  );
}
