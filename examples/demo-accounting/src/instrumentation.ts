export async function register() {
  // Scripted-demo seeding at server boot — idempotent (insert-if-absent for
  // the automations, existing cached apps skipped for chips) and
  // fire-and-forget: the store's cross-process writer lock means a SECOND app
  // instance sharing this .vendo/data (the e2e suites boot one beside a
  // running dev server) would otherwise hang its whole boot polling for the
  // lock. Node runtime only; the module graph pulls in the full Vendo server
  // composition.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { seedDemoScript } = await import("@/demo-script/seed")
    const { pregenerateChips } = await import("@/vendo/chips-seed")
    // Chips ride AFTER the automation seed on the same fire-and-forget chain —
    // both must stay un-awaited (writer-lock gotcha above).
    // CADENCE_DIST_DIR marks a TEST boot (login-e2e, away-drill): those boots
    // must never spend model tokens on chip generation, so only the automation
    // seed (free, no model calls) runs there.
    const testBoot = Boolean(process.env.CADENCE_DIST_DIR)
    seedDemoScript()
      .then(() => (testBoot ? undefined : pregenerateChips()))
      .catch((error: unknown) => {
        console.error("[cadence] demo seeding failed:", error)
      })
  }
}
