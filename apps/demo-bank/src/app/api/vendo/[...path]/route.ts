/**
 * All Vendo endpoints (chat, action, integrations, capabilities, tick) —
 * served by `createVendoHandler()` from `vendo/server`, wired to Maple's
 * demo modules. This replaces the hand-rolled chat/action/integrations
 * routes and is the proof the handler covers a real host's needs:
 *
 *  - the agent cache keys on the demo connection store + automations-world
 *    generation (`cacheKey`), so connecting a toolkit or resetting the demo
 *    rebuilds the agent exactly as before;
 *  - `connections` injects the demo store, so /api/vendo/reset still clears
 *    connection state;
 *  - the demo's own automations world flows in through `tools` (handler
 *    automations stay off, except under the persistence drill — see
 *    ./vendo/handler-options.ts);
 *  - the local-only guard keeps VENDO_DEMO_PUBLIC=1 as the deploy opt-in.
 *
 * The options object lives in ./vendo/handler-options.ts (not inline here)
 * so instrumentation.ts can import the SAME reference for
 * `startVendoScheduler()` — see that file's doc comment for why.
 *
 * The sibling static routes (poll, reset) remain demo-custom and win over
 * this catch-all in Next routing.
 */
import { createVendoHandler } from "vendo/server";
import { vendoOptions } from "@/vendo/handler-options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = createVendoHandler(vendoOptions);
