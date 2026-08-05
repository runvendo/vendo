/**
 * The one door a generated app's tree hangs from.
 *
 * A boxed app is not a page: it is a surface Vendo provisioned, and everything
 * that identifies it (which app it is, which origin its guarded data path talks
 * to) arrives as DATA at provision time rather than as a bake-time constant.
 * The template's entry point mounts this once with what it read from the served
 * page; every hook below it asks `useVendoApp()` instead of re-reading the page.
 *
 * Deliberately the smallest possible context: identity and origin, nothing else.
 * The guarded data hooks (`useToolQuery`, `useVendoState`, the action resolver)
 * are the consumers, and they belong beside it in this package — not a second
 * provider next to it.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface VendoAppContextValue {
  /** The app this surface IS. Absent when the box was provisioned without it —
   *  honestly absent, so a data hook can say so rather than guess an id. */
  appId?: string;
  /** Origin the guarded data path is reached at. Absent means same-origin, which
   *  is what a box-served app gets: its own server proxies to the host. */
  baseUrl?: string;
}

const VendoAppContext = createContext<VendoAppContextValue>({});

export interface VendoAppProviderProps extends VendoAppContextValue {
  children: ReactNode;
}

export function VendoAppProvider({ appId, baseUrl, children }: VendoAppProviderProps) {
  const value = useMemo<VendoAppContextValue>(
    () => ({ ...(appId === undefined ? {} : { appId }), ...(baseUrl === undefined ? {} : { baseUrl }) }),
    [appId, baseUrl],
  );
  return <VendoAppContext.Provider value={value}>{children}</VendoAppContext.Provider>;
}

/** What app this surface is, and where its data path lives. */
export function useVendoApp(): VendoAppContextValue {
  return useContext(VendoAppContext);
}
