/** ENG-225 — the connect dock: the in-bar connect-tools entry (.fl-dock) and
    the liquid tray it opens over the composer (.fl-tray). The dock badge counts
    active accounts; the tray is the designed connection selector — search, the
    host's connectable toolkits, one-click OAuth through the broker (04 §3.1),
    the observed-connect bloom on success.

    The tray must dock flush onto the composer, so `VendoThread` owns the
    open/close state and renders `<ConnectTray>` inside the `.fl-dock-anchor`
    that wraps its composer; `<ConnectDockButton>` rides in the composer row. */
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { useVendoProvider, type ConnectorOption } from "../context.js";
import { useConnections } from "../hooks/use-connections.js";
import { useConnectorCatalog } from "../hooks/use-connector-catalog.js";
import type { ConnectionAccount } from "../wire-types.js";
import { toolkitLogoUrl } from "./build-beat.js";
import { toolkitDisplayName } from "./humanize.js";

const POLL_INTERVAL_MS = 1_500;
const POLL_DEADLINE_MS = 120_000;
const POPUP_WIDTH = 520;
const POPUP_HEIGHT = 680;

/**
 * Open the sign-in window for a connect, SYNCHRONOUSLY inside the click.
 *
 * Safari and Firefox judge a popup by call-stack provenance, not by intent: a
 * `window.open` that runs after an `await` is no longer "during a click" and is
 * refused outright. The old flow awaited `initiate()` first so it could open the
 * window with the real URL in hand — which is precisely the shape those browsers
 * block. So the window opens BLANK on the click and is navigated once the
 * redirect URL arrives (see {@link completeConnection}).
 *
 * `noopener` is deliberately absent: it forces `window.open` to return null, and
 * the handle is what lets us navigate the window and close it from here when the
 * account goes active. The page we send it to is the broker's own consent page.
 *
 * Returns `null` when the browser blocked it anyway — the caller keeps going and
 * offers the same URL as a plain link.
 *
 * @param key Identifies THIS connect, and must be the same key the caller keys
 * its own per-row connect state by. It becomes the window's name, and a name is
 * what makes `window.open` return a window that is ALREADY OPEN: every connect
 * surface here permits concurrent connects, so one shared name meant the second
 * connect inherited the first's window, replaced a sign-in page still in flight,
 * and had it closed underneath by whichever connect settled first.
 */
export function openConnectPopup(key: string): Window | null {
  // Centered on the screen the browser is on, so the consent page lands where
  // the eye already is rather than in a corner behind the app.
  const left = Math.max(0, Math.round((window.screen.width - POPUP_WIDTH) / 2));
  const top = Math.max(0, Math.round((window.screen.height - POPUP_HEIGHT) / 2));
  return window.open(
    "about:blank",
    `vendo-connect-${key}`,
    `popup=yes,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`,
  ) ?? null;
}

/** Initiate a broker connection and poll it to `active` (the ConnectCard flow,
    shared). */
export async function completeConnection(
  client: ReturnType<typeof useVendoProvider>["client"],
  input: { toolkit: string; connector?: string },
  isCancelled: () => boolean,
  /** The window {@link openConnectPopup} returned for THIS click. `null` means
      the browser blocked it: the poll still runs, because the user can finish
      through the fallback link the surface offers. `undefined` means the caller
      opened nothing, so a background tab is opened here instead. */
  popup?: Window | null,
  /** Called once the broker's redirect URL exists — the fallback link's href,
      needed WHILE the poll runs, long before this resolves. */
  onRedirect?: (redirectUrl: string) => void,
): Promise<void> {
  const initiated = await client.connections.initiate(input);
  // The redirect URL is the ONE field of the initiate response the third-party
  // broker writes, and every branch below navigates a window we opened (no
  // `noopener`, so it shares this origin) or offers it as a link. A
  // `javascript:` URL there runs in our own document. Refuse anything that is
  // not http(s) at this single choke point, before it can reach any of them.
  if (!/^https?:\/\//i.test(initiated.redirectUrl)) {
    popup?.close();
    throw new Error(`The ${input.toolkit} connection returned a sign-in URL we won’t open — try again.`);
  }
  onRedirect?.(initiated.redirectUrl);
  if (popup === undefined) window.open(initiated.redirectUrl, "_blank", "noopener");
  else if (popup !== null) popup.location.replace(initiated.redirectUrl);
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (!isCancelled() && Date.now() < deadline) {
    const account = await client.connections
      .status(initiated.id, initiated.connector)
      .catch(() => undefined);
    // Closed from the OPENER: the consent page is the broker's, so there is
    // nothing of ours running inside it to postMessage back.
    if (account?.status === "active") {
      popup?.close();
      return;
    }
    if (account?.status === "failed" || account?.status === "expired") {
      popup?.close();
      throw new Error(`The ${input.toolkit} connection ${account.status} — try again.`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  if (isCancelled()) return;
  popup?.close();
  // Coded, because a deadline is not a refusal: the surface says "nothing
  // changed" and re-offers, where a failure says the connect went wrong.
  throw Object.assign(new Error(`Timed out waiting for the ${input.toolkit} connection — try again.`), { code: "timeout" });
}

/**
 * The consumer's half of a failed connect (spec §16 law 3, the consumer-voice
 * law), living beside the throws it answers. The keyless (default OSS)
 * deployment refuses with a sentence written for the HOST DEVELOPER — "pass a
 * Composio connector (composioConnector) to createVendo({ connectors }) or set
 * VENDO_API_KEY" — and every connect surface rendered `reason.message`, so that
 * TypeScript call and that environment variable reached whoever was trying to
 * connect their Slack. The developer sentence keeps its home (the server's own
 * error, the dev-mode console); the person is told what it means for THEM.
 * `refusalCopy` in grant-set-card is the pattern.
 */
export function connectRefusalCopy(reason: unknown, name: string): string {
  const code = (reason as { code?: unknown } | null)?.code;
  // Nothing is configured behind this button, so there is no retry that helps.
  if (code === "not-implemented" || code === "cloud-required") {
    return `Connecting ${name} isn’t set up here yet — there’s nothing you can do from this screen.`;
  }
  // Guard/policy refusals: the person CAN act, but not from here as they are.
  if (code === "blocked") return `Sign in first, then connect ${name}.`;
  if (code === "forbidden") return `You don’t have access to connect ${name} here.`;
  if (code === "not-found") return `${name} isn’t available to connect any more.`;
  // The OAuth lifecycle failures (failed, expired, timed out) all mean one
  // thing to the person: it did not connect, and trying again is fair.
  return `We couldn’t finish connecting ${name} — nothing changed. You can try again.`;
}

function displayName(option: ConnectorOption): string {
  if (option.label !== undefined) return option.label;
  return toolkitDisplayName(option.toolkit);
}

/** The dock button in the composer row. Hidden only when the host explicitly
    passed `connectors={[]}` ("no connectors, ever") or while the auto catalog
    is still in flight (no flash). An auto catalog that FAILED or resolved to
    nothing keeps the button (2026-07 demo feedback — the dock used to vanish
    whenever /connections wasn't configured): the tray owns the honest
    error/empty state instead. The inner component owns the /connections
    fetch, so a hidden dock never polls accounts; auto mode costs one shared
    /connections/catalog read (useConnectorCatalog). */
export const ConnectDockButton = forwardRef<HTMLButtonElement, { open: boolean; onToggle(): void }>(
  function ConnectDockButton(props, ref) {
    const { options, resolved, explicit } = useConnectorCatalog();
    if (!resolved) return null;
    if (explicit && options.length === 0) return null;
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
export function ConnectTray({ onClose, anchorRef, closing = false }: {
  onClose(): void;
  anchorRef?: React.RefObject<HTMLButtonElement | null>;
  /** Exit phase: the composer keeps the tray mounted while the close
      animation runs; `data-closing` drives it and disables pointer events. */
  closing?: boolean;
}) {
  const { client } = useVendoProvider();
  const { options: connectors, resolved, failed, retry } = useConnectorCatalog();
  const { connections, refresh } = useConnections();
  const [query, setQuery] = useState("");
  const [justConnected, setJustConnected] = useState<string>();
  // All three keyed by toolkit, the way #1051 keyed the panel's `busy` and
  // `blocked`: a connect is a per-ROW flow, and one connect's state standing in
  // for the surface is what made a single connect disable every other connector
  // for the whole 120s poll — silently, since nothing rendered as disabled.
  const [connecting, setConnecting] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  // Connects whose sign-in window the browser refused. The tray opened the
  // window in the click, but offered nothing when it was refused anyway — the
  // row sat on its dots for the whole poll with nowhere to sign in. One notice
  // per waiting connect: a shared one let the second connect erase a link the
  // first still needed. `url` is the broker's own redirect, known only once
  // initiate lands, so the notice explains itself before the link can exist.
  const [blocked, setBlocked] = useState<Record<string, { name: string; url?: string } | undefined>>({});
  // 3-A′ — toolkits whose brand mark failed to load fall back to the monogram.
  const [failedLogos, setFailedLogos] = useState<ReadonlySet<string>>(new Set());
  const trayRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  useEffect(() => {
    // The latch persists across effects; reset it for StrictMode remounts, or
    // the first cleanup latches it for the rest of the tray's life and every
    // connect exits its poll on the first check — silently, since a cancelled
    // flow throws nothing. Same reset ConnectCard does.
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
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
        name: toolkitDisplayName(toolkit),
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
    // Before the first await, or the browser blocks it (openConnectPopup).
    const key = row.toolkit;
    const popup = openConnectPopup(key);
    const clearBlocked = () => setBlocked(current => ({ ...current, [key]: undefined }));
    setConnecting(current => ({ ...current, [key]: true }));
    // Only THIS row's leftovers clear: a sibling connect may still be failing
    // in place, or still waiting on a sign-in link that is its only way through.
    setErrors(current => ({ ...current, [key]: undefined }));
    setBlocked(current => ({ ...current, [key]: popup === null ? { name: row.name } : undefined }));
    try {
      await completeConnection(
        client,
        { toolkit: row.toolkit, ...(row.connector !== undefined ? { connector: row.connector } : {}) },
        () => cancelledRef.current,
        popup,
        // Refused anyway: the connect is initiated and the poll is running, so
        // the same URL in a tab still finishes it.
        url => {
          if (popup === null && !cancelledRef.current) setBlocked(current => ({ ...current, [key]: { name: row.name, url } }));
        },
      );
      if (cancelledRef.current) return;
      clearBlocked();
      await refresh();
      setJustConnected(row.toolkit);
    } catch (reason) {
      if (!cancelledRef.current) {
        // This connect is over, so its link is stale — a retry needs a fresh
        // initiate, and the refusal copy says so.
        clearBlocked();
        setErrors(current => ({ ...current, [key]: connectRefusalCopy(reason, row.name) }));
      }
    } finally {
      if (!cancelledRef.current) setConnecting(current => ({ ...current, [key]: false }));
    }
  };

  const item = (row: TrayRow) => {
    const isConnected = row.account !== undefined;
    const isConnecting = connecting[row.toolkit] === true;
    // Lane pick 3-A′ — real brand marks in the tray rows; the two-letter
    // monogram stays as the fallback for toolkits without a mapped domain or
    // whose mark failed to load.
    const logoUrl = failedLogos.has(row.toolkit) ? undefined : toolkitLogoUrl(row.toolkit);
    return (
      <li
        key={row.key}
        className={`fl-picker-item${isConnected ? " is-connected" : ""}${justConnected === row.toolkit ? " is-just-connected" : ""}`}
      >
        <span className="fl-picker-ic" aria-hidden="true">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- chrome surface, plain img by design
            <img
              src={logoUrl}
              alt=""
              width={15}
              height={15}
              onError={() => setFailedLogos(previous => new Set(previous).add(row.toolkit))}
            />
          ) : (
            row.name.slice(0, 2).toUpperCase()
          )}
        </span>
        <span className="fl-picker-nm">{row.name}</span>
        <span className="fl-picker-status">
          {isConnected ? (
            <span className="fl-picker-on" role="img" aria-label={`${row.name} connected`} />
          ) : isConnecting ? (
            <span className="fl-picker-connecting" role="status" aria-label={`Connecting ${row.name}`}>
              <span className="fl-typing" aria-hidden="true"><span /><span /><span /></span>
            </span>
          ) : (
            // No `disabled`: the row that IS connecting renders its dots above
            // instead of this button, so a second click on the same row is
            // already impossible — and every other row stays a live "+".
            <button
              type="button"
              className="fl-picker-add"
              aria-label={`Connect ${row.name}`}
              onClick={() => void connect(row)}
            >+</button>
          )}
        </span>
      </li>
    );
  };

  return (
    <div ref={trayRef} className="fl-tray" role="dialog" aria-label="Connect tools" data-closing={closing ? "" : undefined}>
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
        {Object.entries(errors).map(([key, message]) => message === undefined ? null : (
          <div key={key} role="alert" className="fl-att-error">{message}</div>
        ))}
        {Object.entries(blocked).map(([key, entry]) => entry === undefined ? null : (
          // The window never opened, but the connect did: the poll is running on
          // that account, so the same URL in a tab finishes it. One notice per
          // connect still waiting — each names its own service, since the tray
          // has many.
          <div key={key} role="status" className="fl-connect-blocked">
            <span>Your browser blocked the {entry.name} sign-in window. Open it yourself — we’ll pick it up from here.</span>
            {entry.url === undefined ? null : (
              <a className="fl-btn fl-btn-primary" href={entry.url} target="_blank" rel="noreferrer">
                Open sign-in in a new tab
              </a>
            )}
          </div>
        ))}
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
        {failed ? (
          // The auto catalog fetch failed — say so and offer a retry (the
          // dock button no longer hides on this; connected accounts above
          // stay listed, the /connections read is independent).
          <div className="fl-auto-sub" role="status">
            Couldn&rsquo;t load the available tools.{" "}
            <button type="button" className="fl-more" onClick={retry}>Try again</button>
          </div>
        ) : rows.connected.length === 0 && rows.available.length === 0 ? (
          // The honest empty voice, in order of specificity: a search that
          // matched nothing, the catalog still in flight, and a catalog that
          // genuinely has nothing to offer yet.
          query.length > 0 ? (
            <div className="fl-auto-sub" role="status">No matching tools</div>
          ) : !resolved ? (
            <div className="fl-auto-sub" role="status">Loading available tools&hellip;</div>
          ) : (
            <div className="fl-auto-sub" role="status">No tools are available to connect yet.</div>
          )
        ) : null}
      </div>
    </div>
  );
}
