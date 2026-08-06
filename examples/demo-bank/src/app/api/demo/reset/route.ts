import { eraseStore, storeFiles } from "@vendoai/store";
import type { HostedStore } from "@vendoai/vendo/server";
import { seedDemoScript } from "@/demo-script/seed";
import { __reseed } from "@/server/store";
import { MAPLE_SCENARIOS, type MapleScenario } from "@/server/seed";
import { ok } from "@/server/http";
import { mapleDemoUsers } from "@/server/users";
import { demoRequestAllowed } from "@/vendo/request";
import { sweepDemoConnections } from "@/vendo/reset-connections";
import { vendo } from "@/vendo/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The store's erase cascade, store-implementation-agnostic: the Cloud hosted
 *  store carries its own erase door (the cascade runs server-side with
 *  eraseStore parity); a local store goes through eraseStore's SQL cascade. */
function eraseDoor(): Pick<HostedStore["erase"], "bySubject"> {
  const hosted = vendo.store as Partial<HostedStore>;
  // The workspace's own content lives behind a files adapter, so erase needs it
  // (build contract §3.4). This demo wires no `files:`, so it is the store-backed
  // one — named explicitly, because a silent default is how rows get erased while
  // a real bucket keeps the bytes.
  return typeof hosted.erase?.bySubject === "function"
    ? hosted.erase
    : eraseStore(vendo.store, { files: storeFiles(vendo.store) });
}

export async function POST(req: Request) {
  if (!demoRequestAllowed(req)) {
    return Response.json({ error: "reset is restricted to the demo's own origin" }, { status: 403 });
  }
  // Optional scenario lever: {"scenario": "low-balance"} stages a specific
  // story. Unknown names are a 400, never a silent fall-through to the
  // default seed — a demo script must not think it staged a scenario it
  // didn't. Absent body/scenario = the standard seed.
  let scenario: MapleScenario | undefined;
  const body = await req.json().catch(() => null);
  if (body !== null && body.scenario !== undefined) {
    if (!MAPLE_SCENARIOS.includes(body.scenario)) {
      return Response.json(
        { error: `unknown scenario "${body.scenario}" — known: ${MAPLE_SCENARIOS.join(", ")}` },
        { status: 400 },
      );
    }
    scenario = body.scenario;
  }
  __reseed(new Date(), scenario);
  // Demo-refresh 2026-07-23: reset also erases the demo subjects' Vendo state
  // (threads, generated apps, pins, grants) through the store's sanctioned
  // erase cascade, so slots and conversations return to out-of-the-box.
  const erase = eraseDoor();
  for (const user of mapleDemoUsers()) {
    await erase.bySubject(user.subject);
  }
  // Demo-hygiene: connected accounts live broker-side and survive both the
  // erase cascade and redeploys — sweep them so reset returns connections to
  // out-of-the-box too.
  await sweepDemoConnections(vendo.connections, mapleDemoUsers());
  // Scripted demo: re-seed the fixture microapps + the weekly-summary
  // automation so the four scenario cards are replayable immediately.
  await seedDemoScript();
  return ok({ reset: true });
}
