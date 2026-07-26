export async function register() {
  // Scripted-demo seeding at server boot (idempotent — insert-if-absent):
  // the fixture microapps + the weekly automation exist before the first
  // scenario card is clicked. Node runtime only; the module graph pulls in
  // the full Vendo server composition. Fire-and-forget: the store's
  // cross-process writer lock means a SECOND app instance sharing this
  // .vendo/data (the away-drill test boots one beside a running dev server)
  // would otherwise hang its whole boot polling for the lock.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { seedDemoScript } = await import("@/demo-script/seed");
    seedDemoScript().catch((error: unknown) => {
      console.error("[maple] demo-script seeding failed:", error);
    });
  }
}
