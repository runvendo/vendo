/**
 * The ONE provider a code-land app mounts (blueprint §5.4).
 *
 * It carries everything the guarded hooks need and nothing else: which app
 * this is, where its wire lives, the keyed `$state` store, and the set of
 * mounted queries a successful action refreshes (§6.3 law 2). One provider,
 * one context — not one per hook.
 *
 * WHERE THE ADDRESS COMES FROM. A box-served app is served BY the wire, at
 * `<wire base>/apps/<appId>/serve/` (vendo/src/wire/box.ts servedProxyRoutes,
 * vendo/src/server.ts servedProxyPath). So the app's own URL already carries
 * both halves, and both are derived from it — no global, no build-time
 * injection, and it survives a host that mounts the wire under a base path
 * (Next.js `basePath`, the demos' `withBasePath`). The props are the escape
 * hatch for the interim (a dev server, the box's own `VENDO_HOST_URL`), and
 * an explicit prop always wins.
 */

import type { Json, ToolOutcome } from "@vendoai/core";
import { createVendoClient } from "../client-impl.js";
import { useKeyedState, type KeyedState } from "./state.js";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

/** What a mounted `useToolQuery` registers so an action can refresh it. */
export type QueryRefetch = () => Promise<void>;

/** The value every hook in this package reads. */
export interface VendoAppContextValue {
  /** The app whose guarded door the hooks call. Empty when it could not be
   *  determined — the hooks then report an unavailable read instead of
   *  guessing an id. */
  appId: string;
  /** The wire's base, e.g. `/api/vendo`. Relative and same-origin by default,
   *  so every call rides the viewer's own session. */
  baseUrl: string;
  /**
   * THE ONE DOOR: `POST <baseUrl>/apps/:appId/call`, through the same
   * `createVendoClient` the host's own chrome calls it with. Total — a
   * transport failure, a wire error envelope and a missing app id all arrive
   * as a contained `error` outcome, never a throw.
   */
  call(ref: string, args: Json): Promise<ToolOutcome>;
  /** The keyed `$state` namespace for this app instance. */
  state: KeyedState;
  setState(key: string, value: Json): void;
  /** Called by `useToolQuery` on mount; returns its unregister. */
  registerQuery(refetch: QueryRefetch): () => void;
  /** Re-run every mounted query. What a successful action triggers. */
  refetchQueries(): Promise<void>;
  /**
   * Say ONCE, per distinct miss, that a read resolved no data — the same
   * report `createProgressiveQueryResolver` makes server-side (apps/open.ts).
   * A binding that renders empty because a call was refused looks exactly like
   * one that renders empty because there is nothing to show; that silence cost
   * a live triage, so it stops being invisible here too.
   */
  reportQueryMiss(key: string, message: string): void;
}

const VendoAppContext = createContext<VendoAppContextValue | null>(null);

/** The serve route's shape — the one fact the address is derived from. */
const SERVED_PATH = /^(.*)\/apps\/([^/]+)\/serve(?:\/|$)/;

/** `/api/vendo/apps/app_1/serve/index.html` → `{ baseUrl, appId }`. */
export function appAddressFromPath(pathname: string): { baseUrl: string; appId: string } | undefined {
  const match = SERVED_PATH.exec(pathname);
  if (match === null) return undefined;
  const [, baseUrl = "", appId = ""] = match;
  if (appId === "") return undefined;
  return { baseUrl, appId: decodeURIComponent(appId) };
}

const servedAddress = (): { baseUrl: string; appId: string } | undefined =>
  typeof window === "undefined" ? undefined : appAddressFromPath(window.location.pathname);

export interface VendoAppProviderProps {
  /** Overrides the id derived from the served URL. */
  appId?: string;
  /** Overrides the wire base derived from the served URL, e.g. `/api/vendo`
   *  or an absolute `http://localhost:3000/api/vendo` for a dev server. */
  baseUrl?: string;
  children?: ReactNode;
}

/** A door failure the app must render, not crash on. */
const errorOutcome = (message: string): ToolOutcome => ({
  status: "error",
  error: { code: "call", message },
});

const NO_APP_ID = "no app id: mount <VendoAppProvider> at the app's root";

const NO_APP_ID_ADVICE =
  "[vendo] this app does not know which app it is, so no call can be guarded — mount <VendoAppProvider> "
  + "at the app's root (it derives the id from the served URL; pass appId to override)";

/** The one provider. A generated app's entry point mounts this at its root. */
export function VendoAppProvider({ appId, baseUrl, children }: VendoAppProviderProps) {
  const [state, setState] = useKeyedState();
  const queries = useRef(new Set<QueryRefetch>());
  const reported = useRef(new Set<string>());

  const address = useMemo(() => {
    const derived = appId === undefined || baseUrl === undefined ? servedAddress() : undefined;
    return {
      appId: appId ?? derived?.appId ?? "",
      // "" means "unknown": the client's own default (`/api/vendo`) then
      // applies, rather than this package inventing a second default.
      baseUrl: baseUrl ?? derived?.baseUrl ?? "",
    };
  }, [appId, baseUrl]);

  // The host's own client, so there is one door implementation and one
  // anonymous-session gate. Relative + same-origin by default: the call rides
  // the viewer's session, which IS the auth mechanism.
  const client = useMemo(
    () => createVendoClient(address.baseUrl === "" ? {} : { baseUrl: address.baseUrl }),
    [address.baseUrl],
  );

  const reportQueryMiss = useCallback((key: string, message: string) => {
    if (reported.current.has(key)) return;
    reported.current.add(key);
    console.warn(message);
  }, []);

  const call = useCallback(async (ref: string, args: Json): Promise<ToolOutcome> => {
    if (address.appId === "") {
      reportQueryMiss("missing-app-id", NO_APP_ID_ADVICE);
      return errorOutcome(NO_APP_ID);
    }
    try {
      return await client.apps.call(address.appId, ref, args);
    } catch (error) {
      // A network failure, a wire error envelope, an unserializable payload:
      // every one of them is a contained outcome the screen can render.
      return errorOutcome(error instanceof Error ? error.message : String(error));
    }
  }, [client, address.appId, reportQueryMiss]);

  const registerQuery = useCallback((refetch: QueryRefetch) => {
    queries.current.add(refetch);
    return () => {
      queries.current.delete(refetch);
    };
  }, []);

  const refetchQueries = useCallback(async () => {
    // Every query on the screen, in parallel. A refetch never throws (an
    // unavailable read is a state, not an exception), so no settling dance.
    await Promise.all([...queries.current].map((refetch) => refetch()));
  }, []);

  const value = useMemo<VendoAppContextValue>(() => ({
    appId: address.appId,
    baseUrl: client.baseUrl,
    call,
    state,
    setState,
    registerQuery,
    refetchQueries,
    reportQueryMiss,
  }), [address.appId, client, call, state, setState, registerQuery, refetchQueries, reportQueryMiss]);

  return <VendoAppContext.Provider value={value}>{children}</VendoAppContext.Provider>;
}

/** An app rendered outside the provider is a wiring bug in the template, not a
 *  data problem — so it degrades exactly like an unavailable read (empty id,
 *  every call reporting unavailable) instead of throwing a blank screen. The
 *  hooks say so once, in the developer's console. */
let orphanReported = false;

const ORPHAN: VendoAppContextValue = {
  appId: "",
  baseUrl: "",
  call: async () => {
    if (!orphanReported) {
      orphanReported = true;
      console.warn(NO_APP_ID_ADVICE);
    }
    return errorOutcome(NO_APP_ID);
  },
  state: {},
  setState: () => undefined,
  registerQuery: () => () => undefined,
  refetchQueries: async () => undefined,
  reportQueryMiss: (_key, message) => console.warn(message),
};

/** The context, for a component that needs the address or the whole store. */
export function useVendoApp(): VendoAppContextValue {
  return useContext(VendoAppContext) ?? ORPHAN;
}
