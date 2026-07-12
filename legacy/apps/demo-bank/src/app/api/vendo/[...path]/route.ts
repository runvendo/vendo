/**
 * Vendo chat, action, integration, capability, and thread endpoints —
 * served by `createVendoHandler()` from `vendoai/server`, wired to Maple's
 * demo modules. This replaces the hand-rolled chat/action/integrations
 * routes and is the proof the handler covers a real host's needs:
 *
 *  - `connections` injects the demo store, so /api/vendo/reset still clears
 *    connection state;
 *  - `tools` exposes Maple's transaction reader alongside the live host API;
 *  - the local-only guard keeps VENDO_DEMO_PUBLIC=1 as the deploy opt-in.
 *
 * The options object lives in ./vendo/handler-options.ts (not inline here)
 * so every route uses the same host configuration.
 *
 * The sibling static routes (reset and voice) remain demo-custom and win over
 * this catch-all in Next routing.
 */
import { createVendoHandler } from "vendoai/server";
import { vendoOptions } from "@/vendo/handler-options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = createVendoHandler(vendoOptions);
