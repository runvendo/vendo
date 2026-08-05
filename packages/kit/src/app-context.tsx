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

import type { Json } from "@vendoai/core";
import { useKeyedState, type KeyedState } from "@vendoai/ui/kit";
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
  /** The keyed `$state` namespace for this app instance. */
  state: KeyedState;
  setState(key: string, value: Json): void;
  /** Called by `useToolQuery` on mount; returns its unregister. */
  registerQuery(refetch: QueryRefetch): () => void;
  /** Re-run every mounted query. What a successful action triggers. */
  refetchQueries(): Promise<void>;
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

/** The one provider. A generated app's entry point mounts this at its root. */
export function VendoAppProvider({ appId, baseUrl, children }: VendoAppProviderProps) {
  const [state, setState] = useKeyedState();
  const queries = useRef(new Set<QueryRefetch>());

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

  const value = useMemo<VendoAppContextValue>(() => {
    const derived = appId === undefined || baseUrl === undefined ? servedAddress() : undefined;
    return {
      appId: appId ?? derived?.appId ?? "",
      baseUrl: baseUrl ?? derived?.baseUrl ?? "",
      state,
      setState,
      registerQuery,
      refetchQueries,
    };
  }, [appId, baseUrl, state, setState, registerQuery, refetchQueries]);

  return <VendoAppContext.Provider value={value}>{children}</VendoAppContext.Provider>;
}

/** An app rendered outside the provider is a wiring bug in the template, not a
 *  data problem — so it degrades exactly like an unavailable read (empty id,
 *  every call reporting unavailable) instead of throwing a blank screen. The
 *  hooks say so once, in the developer's console. */
const ORPHAN: VendoAppContextValue = {
  appId: "",
  baseUrl: "",
  state: {},
  setState: () => undefined,
  registerQuery: () => () => undefined,
  refetchQueries: async () => undefined,
};

/** The context, for a component that needs the address or the whole store. */
export function useVendoApp(): VendoAppContextValue {
  return useContext(VendoAppContext) ?? ORPHAN;
}
