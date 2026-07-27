export async function register() {
  // Chip pre-generation at server boot (demo-hygiene) — idempotent (existing
  // cached apps are skipped) and fire-and-forget: the store's cross-process
  // writer lock means a SECOND app instance sharing this .vendo/data (the
  // e2e suites boot one beside a running dev server) would otherwise hang
  // its whole boot polling for the lock. Node runtime only; the module graph
  // pulls in the full Vendo server composition.
  // CADENCE_DIST_DIR marks a TEST boot (login-e2e, away-drill): those boots
  // must never spend model tokens on chip generation.
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.CADENCE_DIST_DIR) {
    const { pregenerateChips } = await import("@/vendo/chips-seed")
    pregenerateChips().catch((error: unknown) => {
      console.error("[cadence] chip pre-generation failed:", error)
    })
  }
}
