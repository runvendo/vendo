/**
 * `createFlowletHandler()` — the one-call Next.js (App Router) adapter.
 *
 * Wire it in a catch-all route and everything demo-bank hand-rolls is served
 * from one place:
 *
 *   // app/api/flowlet/[...path]/route.ts
 *   import { createFlowletHandler } from "@flowlet/next";
 *   export const runtime = "nodejs";
 *   export const dynamic = "force-dynamic";
 *   export const { GET, POST } = createFlowletHandler();
 *
 * All routing/assembly lives in `@flowlet/server`'s framework-agnostic
 * `createFlowletFetchHandler` — see its docblock for the endpoint list and
 * the ZERO-CONFIG contract. This file just points both HTTP methods at it.
 */
import { createFlowletFetchHandler, type FlowletHandlerOptions } from "@flowlet/server";

export interface FlowletRouteHandlers {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
}

export function createFlowletHandler(options: FlowletHandlerOptions = {}): FlowletRouteHandlers {
  const handler = createFlowletFetchHandler(options);
  return { GET: handler, POST: handler };
}
