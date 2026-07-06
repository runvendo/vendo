/**
 * `createVendoHandler()` — the ready-made `{ GET, POST }` pair for
 * file-router catch-alls. Next.js App Router is the canonical example:
 *
 *   // app/api/vendo/[...path]/route.ts
 *   // ("vendoai/server" is the public `vendoai` umbrella subpath that
 *   // re-exports this package)
 *   import { createVendoHandler } from "vendoai/server";
 *   export const runtime = "nodejs";
 *   export const dynamic = "force-dynamic";
 *   export const { GET, POST } = createVendoHandler();
 *
 * All routing/assembly lives in `createVendoFetchHandler` — see its
 * docblock for the endpoint list and the ZERO-CONFIG contract. This file
 * just points both HTTP methods at it.
 */
import { createVendoFetchHandler } from "./fetch-handler.js";
import type { VendoHandlerOptions } from "./options.js";

export interface VendoRouteHandlers {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
}

export function createVendoHandler(options: VendoHandlerOptions = {}): VendoRouteHandlers {
  const handler = createVendoFetchHandler(options);
  return { GET: handler, POST: handler };
}
