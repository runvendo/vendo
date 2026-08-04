/**
 * The demo hosts' component registries, for the Vendo pane.
 *
 * Each demo host owns exactly ONE registry object (01 §14): its server passes
 * it to `createVendo` as `catalog` (so the engine can generate references to
 * `MapleNetWorthCard`), and its client passes it to `<VendoRoot>` as
 * `components` (so the renderer can resolve those references). The bench's
 * Vendo pane is the client half of that pair, so it must hold the same object
 * — otherwise the engine generates a host component the pane cannot render and
 * the renderer answers with its Unknown-component notice.
 *
 * The registries are imported by relative path rather than through a workspace
 * dependency on purpose: what the pane needs is source, and a package edge
 * would put the whole demo-app build (vendo sync + next build) in front of
 * genui-bench in the turbo graph for nothing. genui-bench is private and never
 * published, so no published dependency is created either way.
 */
import type { ComponentType } from "react";
import { hostComponentMap } from "@vendoai/ui";
import { cadenceRegistry } from "../../../../examples/demo-accounting/src/vendo/registry";
import { mapleRegistry } from "../../../../examples/demo-bank/src/vendo/registry";
import type { HostName } from "../../runner/types";

export const hostComponents: Record<HostName, Record<string, ComponentType>> = {
  maple: hostComponentMap(mapleRegistry),
  cadence: hostComponentMap(cadenceRegistry),
};
