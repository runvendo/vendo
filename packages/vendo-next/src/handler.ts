/**
 * `createVendoHandler()` — the one-call Next.js (App Router) adapter.
 *
 * Wire it in a catch-all route and everything demo-bank hand-rolls is served
 * from one place:
 *
 *   // app/api/vendo/[...path]/route.ts
 *   import { createVendoHandler } from "@vendoai/next";
 *   export const runtime = "nodejs";
 *   export const dynamic = "force-dynamic";
 *   export const { GET, POST } = createVendoHandler();
 *
 * All routing/assembly lives in `@vendoai/server`'s framework-agnostic
 * `createVendoFetchHandler` — see its docblock for the endpoint list and
 * the ZERO-CONFIG contract. This file just points both HTTP methods at it.
 */
import { createVendoFetchHandler, type VendoHandlerOptions } from "@vendoai/server";

// Re-exported so route-level consumers (and tests) can resolve the tail the
// same way the fetch handler does.
export { routeTail, resetVendoBootRegistry } from "@vendoai/server";

export interface VendoRouteHandlers {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
}

export function createVendoHandler(options: VendoHandlerOptions = {}): VendoRouteHandlers {
  const handler = createVendoFetchHandler(options);
  return { GET: handler, POST: handler };
}
