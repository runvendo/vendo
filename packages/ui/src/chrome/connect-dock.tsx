/** ENG-225 — the connect dock: the in-bar connect-tools entry (.fl-dock) and
    the liquid tray it opens over the composer (.fl-tray). The dock badge counts
    active accounts; the tray is the designed connection selector — search, the
    host's connectable toolkits, one-click OAuth through the broker (04 §3.1),
    the observed-connect bloom on success.

    The tray must dock flush onto the composer, so `VendoThread` owns the
    open/close state and renders `<ConnectTray>` inside the `.fl-dock-anchor`
    that wraps its composer; `<ConnectDockButton>` rides in the composer row. */
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { useVendoContext, type ConnectorOption } from "../context.js";
import { useConnections } from "../hooks/use-connections.js";
import type { ConnectionAccount } from "../wire-types.js";

const POLL_INTERVAL_MS = 1_500;
const POLL_DEADLINE_MS = 120_000;

/** Initiate a broker connection and poll it to `active` (the ConnectCard flow,
    shared). Opens the hosted OAuth redirect in its own window. */
export async function completeConnection(
  client: ReturnType<typeof useVendoContext>["client"],
  input: { toolkit: string; connector?: string },
  isCancelled: () => boolean,
): Promise<void> {
  const initiated = await client.connections.initiate(input);
  window.open(initiated.redirectUrl, "_blank", "noopener");
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (!isCancelled() && Date.now() < deadline) {
    const account = await client.connections
      .status(initiated.id, initiated.connector)
      .catch(() => undefined);
    if (account?.status === "active") return;
    if (account?.status === "failed" || account?.status === "expired") {
      throw new Error(`The ${input.toolkit} connection ${account.status} — try again.`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  if (!isCancelled()) throw new Error(`Timed out waiting for the ${input.toolkit} connection — try again.`);
}

function displayName(option: ConnectorOption): string {
  if (option.label !== undefined) return option.label;
  return option.toolkit.charAt(0).toUpperCase() + option.toolkit.slice(1);
}

/** The dock button in the composer row. Renders nothing when the host supplied
    no connector catalog — the dock is opt-in chrome, and a thread without it
    must not fetch /connections at all (the inner component owns the fetch). */
export const ConnectDockButton = forwardRef<HTMLButtonElement, { open: boolean; onToggle(): void }>(
  function ConnectDockButton(props, ref) {
    const { connectors } = useVendoContext();
    if (connectors.length === 0) return null;
    return <DockButtonInner {...props} buttonRef={ref} />;
  },
);

function DockButtonInner({ open, onToggle, buttonRef }: {
  open: boolean;
  onToggle(): void;
  buttonRef: React.ForwardedRef<HTMLButtonElement>;
}) {
  // Devin/ENG-225 review: the badge and the tray hold separate useConnections
  // instances (useResource is per-hook), so a connect made in the tray never
  // reached the badge. Poll so the count converges after a connect — the same
  // cross-instance freshness pattern the approvals surfaces use (ENG-219).
  const { connections } = useConnections({ pollMs: 3_000 });
  const active = connections.filter(account => account.status === "active").length;
  return (
      <span className="fl-dock">
        <span className="fl-dock-ripple">
          <button
            ref={buttonRef}
            type="button"
            className="fl-icon-btn fl-dock-btn"
            aria-label="Connect tools"
            aria-expanded={open}
            onClick={onToggle}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8" />
            </svg>
          </button>
        </span>
        {active > 0 ? <span className="fl-dock-badge" aria-hidden="true">{active}</span> : null}
      </span>
  );
}

interface TrayRow {
  key: string;
  name: string;
  toolkit: string;
  connector?: string;
  account?: ConnectionAccount;
}

/** The liquid tray: rendered by VendoThread inside `.fl-dock-anchor`, above the
    composer it docks onto. `anchorRef` is the dock button that opened it — an
    outside-press on THAT button must not close (the button's own click toggles;
    closing here first would let the toggle reopen it, Devin/Greptile review). */
export function ConnectTray({ onClose, anchorRef }: {
  onClose(): void;
  anchorRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const { client, connectors } = useVendoContext();
  const { connections, refresh } = useConnections();
  const [query, setQuery] = useState("");
  const [connecting, setConnecting] = useState<string>();
  const [justConnected, setJustConnected] = useState<string>();
  const [error, setError] = useState<string>();
  const trayRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  useEffect(() => () => {
    cancelledRef.current = true;
  }, []);

  // --fl-tray-max: the room actually above the bar within this surface, so the
  // tray never runs off the top — the picker scrolls internally instead.
  useEffect(() => {
    const tray = trayRef.current;
    if (!tray) return;
    const surface = tray.closest<HTMLElement>(".fl-thread") ?? undefined;
    if (surface) {
      const room = tray.parentElement!.getBoundingClientRect().top - surface.getBoundingClientRect().top - 12;
      if (room > 80) tray.style.setProperty("--fl-tray-max", `${Math.round(room)}px`);
    }
    searchRef.current?.focus();
  }, []);

  // Escape and outside-press close the tray (focus restoration is the
  // caller's job — it owns the dock button).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPress = (event: MouseEvent) => {
      const tray = trayRef.current;
      if (!tray || !(event.target instanceof Node)) return;
      if (tray.contains(event.target)) return;
      // The dock button owns its own toggle; let it close the tray itself.
      if (anchorRef?.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPress);
    };
  }, [onClose, anchorRef]);

  const rows = useMemo<{ connected: TrayRow[]; available: TrayRow[] }>(() => {
    const activeByToolkit = new Map<string, ConnectionAccount>();
    for (const account of connections) {
      if (account.status === "active") activeByToolkit.set(account.toolkit, account);
    }
    const connected: TrayRow[] = [];
    const available: TrayRow[] = [];
    const listed = new Set<string>();
    for (const option of connectors) {
      listed.add(option.toolkit);
      const account = activeByToolkit.get(option.toolkit);
      const row: TrayRow = {
        key: option.toolkit,
        name: displayName(option),
        toolkit: option.toolkit,
        ...(option.connector !== undefined ? { connector: option.connector } : {}),
        ...(account !== undefined ? { account } : {}),
      };
      (account !== undefined ? connected : available).push(row);
    }
    // Accounts outside the host catalog still show as connected — the list is
    // the user's truth, not the catalog's.
    for (const [toolkit, account] of activeByToolkit) {
      if (listed.has(toolkit)) continue;
      connected.push({
        key: toolkit,
        name: toolkit.charAt(0).toUpperCase() + toolkit.slice(1),
        toolkit,
        connector: account.connector,
        account,
      });
    }
    const match = (row: TrayRow) =>
      row.name.toLowerCase().includes(query.toLowerCase()) || row.toolkit.toLowerCase().includes(query.toLowerCase());
    return { connected: connected.filter(match), available: available.filter(match) };
  }, [connections, connectors, query]);

  const connect = async (row: TrayRow) => {
    setConnecting(row.toolkit);
    setError(undefined);
    try {
      await completeConnection(
        client,
        { toolkit: row.toolkit, ...(row.connector !== undefined ? { connector: row.connector } : {}) },
        () => cancelledRef.current,
      );
      if (cancelledRef.current) return;
      await refresh();
      setJustConnected(row.toolkit);
    } catch (reason) {
      if (!cancelledRef.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!cancelledRef.current) setConnecting(undefined);
    }
  };

  const item = (row: TrayRow) => {
    const isConnected = row.account !== undefined;
    const isConnecting = connecting === row.toolkit;
    return (
      <li
        key={row.key}
        className={`fl-picker-item${isConnected ? " is-connected" : ""}${justConnected === row.toolkit ? " is-just-connected" : ""}`}
      >
        <span className="fl-picker-ic" aria-hidden="true">{row.name.slice(0, 2).toUpperCase()}</span>
        <span className="fl-picker-nm">{row.name}</span>
        <span className="fl-picker-status">
          {isConnected ? (
            <span className="fl-picker-on" role="img" aria-label={`${row.name} connected`} />
          ) : isConnecting ? (
            <span className="fl-picker-connecting" role="status" aria-label={`Connecting ${row.name}`}>
              <span className="fl-typing" aria-hidden="true"><span /><span /><span /></span>
            </span>
          ) : (
            <button
              type="button"
              className="fl-picker-add"
              aria-label={`Connect ${row.name}`}
              disabled={connecting !== undefined}
              onClick={() => void connect(row)}
            >+</button>
          )}
        </span>
      </li>
    );
  };

  return (
    <div ref={trayRef} className="fl-tray" role="dialog" aria-label="Connect tools">
      <div className="fl-picker">
        <div className="fl-picker-toprow">
          <input
            ref={searchRef}
            className="fl-picker-search"
            type="search"
            aria-label="Search tools"
            placeholder="Search tools"
            value={query}
            onChange={event => setQuery(event.currentTarget.value)}
          />
          <button type="button" className="fl-picker-close" aria-label="Close connect tray" onClick={onClose}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {error !== undefined ? <div role="alert" className="fl-att-error">{error}</div> : null}
        {rows.connected.length > 0 ? (
          <>
            <div className="fl-picker-group">Connected</div>
            <ul className="fl-picker-grid" style={{ listStyle: "none", margin: 0 }}>{rows.connected.map(item)}</ul>
          </>
        ) : null}
        {rows.available.length > 0 ? (
          <>
            <div className="fl-picker-group">Available</div>
            <ul className="fl-picker-grid" style={{ listStyle: "none", margin: 0 }}>{rows.available.map(item)}</ul>
          </>
        ) : null}
        {rows.connected.length === 0 && rows.available.length === 0 ? (
          <div className="fl-auto-sub" role="status">No matching tools</div>
        ) : null}
      </div>
    </div>
  );
}
