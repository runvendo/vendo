import { createContext, useContext, useMemo, type ReactNode } from "react";

/** Host-owned discovery copy for the current product surface. It stays in the
 * UI tree and is never part of a thread request or model context. */
export interface VendoSurfaceValue {
  label: string;
  starters: readonly string[];
}

const VendoSurfaceContext = createContext<VendoSurfaceValue | undefined>(undefined);

/** Scope explicit, host-authored starters to a page or route. Place the
 * corresponding VendoOverlay inside this boundary. */
export function VendoSurface({ label, starters, children }: VendoSurfaceValue & { children: ReactNode }): ReactNode {
  const value = useMemo<VendoSurfaceValue>(
    () => ({ label, starters: starters.slice(0, 3) }),
    [label, starters],
  );
  return <VendoSurfaceContext.Provider value={value}>{children}</VendoSurfaceContext.Provider>;
}

export function useVendoSurface(): VendoSurfaceValue | undefined {
  return useContext(VendoSurfaceContext);
}
