export async function register() {
  // Scripted-demo seeding at server boot (idempotent — insert-if-absent):
  // the fixture microapps + the weekly automation exist before the first
  // scenario card is clicked. Node runtime only; the module graph pulls in
  // the full Vendo server composition. Fire-and-forget: the store's
  // cross-process writer lock means a SECOND app instance sharing this
  // .vendo/data (the away-drill test boots one beside a running dev server)
  // would otherwise hang its whole boot polling for the lock.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Boot seeding calls host_* tools before any request has taught the wire
    // its own origin, so an unset VENDO_BASE_URL (the local-dev posture) makes
    // every route-bound call fail. Prime the loopback origin first — the FULL
    // public URL, /maple included (spec 2026-08-06 §B1: nothing strips
    // VENDO_BASE_URL's path).
    process.env.VENDO_BASE_URL ??= `http://localhost:${process.env.PORT ?? 3000}/maple`;
    const { seedDemoScript } = await import("@/demo-script/seed.js");
    seedDemoScript().catch((error: unknown) => {
      console.error("[maple] demo seeding failed:", error);
    });
  }
}
