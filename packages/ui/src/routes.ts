/** The host's route registry and its navigator — the two halves a `<Link>` reads. */
import { useContext } from "react";
import type { VendoNavigation, VendoRouteMap } from "@vendoai/apps/contract";
import { VendoContext } from "./context.js";

/** The routes the host registered, provider-optional: a tree rendered standalone
    has no registry, so every target is unknown and no link resolves. */
export function useVendoRoutes(): VendoRouteMap {
  return useContext(VendoContext)?.routes ?? {};
}

/** The host's navigation handler, provider-optional. Absent, a Link renders its
    text and goes nowhere — the host never said how to move. */
export function useVendoNavigate(): ((nav: VendoNavigation) => void) | undefined {
  return useContext(VendoContext)?.onNavigate;
}
