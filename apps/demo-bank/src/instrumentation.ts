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
    const { pregenerateChips } = await import("@/vendo/chips-seed");
    // Chips ride AFTER the fixture seed on the same fire-and-forget chain —
    // both must stay un-awaited (writer-lock gotcha above), and generation is
    // idempotent so repeated boots only repair gaps.
    // MAPLE_DIST_DIR marks a TEST boot (away-drill and friends): those boots
    // must never spend model tokens on chip generation, so only the fixture
    // seed runs there.
    const testBoot = Boolean(process.env.MAPLE_DIST_DIR);
    seedDemoScript()
      .then(() => (testBoot ? undefined : pregenerateChips()))
      .catch((error: unknown) => {
        console.error("[maple] demo seeding failed:", error);
      });
  }
}
