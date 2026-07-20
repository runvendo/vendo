import type { HttpMethod } from "../formats.js";

/**
 * Route-scan input-schema inference (PR 2, 04 §1): a collector seam asked
 * once per (route, method) at route-scan's single emission point. Collector
 * order (spec-locked): zod-in-handler first (Task 2, reuses the
 * oracle-hardened `zodFromExpression` from `static-ts.ts`), then the
 * TypeScript-checker collector (Task 3, one lazily built `ts.Program` per
 * scan), with the query collector (Task 4) merging additively into whichever
 * of those two results comes back. Every collector fails closed: no
 * recognizable evidence means `null`, and route-scan emits exactly what it
 * emits today (path params only, blank body/query). Nothing recognizes
 * anything yet — `inferRouteInput` always returns `null`; this module is the
 * zero-behavior-change wiring point Tasks 2-4 fill in.
 */

/** The minimal route facts a collector needs. A structural subset of
 * route-scan's internal `RouteSource` — this module never imports from
 * route-scan.ts, so collectors stay one-directional (asked, never asking
 * back). */
export interface RouteContext {
  file: string;
  source: string;
  urlPath: string;
  kind: "app" | "pages";
}

/**
 * State shared across every `inferRouteInput` call within one `scanRoutes`
 * pass — created once per scan by `createRouteScanState`, then threaded
 * through unchanged call to call. Empty today (Task 1's zero-behavior-change
 * seam); Task 2 grows it with a `StaticExtraction` (module parse cache) for
 * the zod collector, Task 3 with a lazily built `ts.Program` for the checker
 * collector. Growing this interface in place is how later collectors avoid
 * re-parsing modules, or re-touching route-scan.ts's call site, ever again.
 */
export interface RouteScanState {
  root: string;
}

export function createRouteScanState(root: string): RouteScanState {
  return { root };
}

/**
 * One collector's verdict for a route+method's input, additive by design:
 * `bodySchema` / `queryProperties` are undefined when that collector found
 * nothing for that half of the tool's args, and `note` carries a fail-closed
 * reason onto the emitted tool exactly like the tRPC/server-actions
 * extractors do for partially- or un-recognized shapes (04 §1).
 */
export interface RouteInputResult {
  bodySchema?: Record<string, unknown>;
  queryProperties?: Record<string, unknown>;
  note?: string;
}

/**
 * Ask every collector (spec-locked order) for `route`'s `method` input.
 * Returns `null` when nothing is recognized, so route-scan falls back to
 * today's exact path-params-only emission (fail-closed, byte-identical).
 * Collectors land in Tasks 2 (zod-in-handler), 3 (TypeScript checker), and 4
 * (query); until then this seam always returns `null`.
 */
export async function inferRouteInput(
  _route: RouteContext,
  _method: HttpMethod,
  _state: RouteScanState,
): Promise<RouteInputResult | null> {
  return null;
}
