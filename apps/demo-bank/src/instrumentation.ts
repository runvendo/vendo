/**
 * Boots the Flowlet automation scheduler for the kill-the-server persistence
 * drill (scripts/drill-persistence.mjs — see
 * docs/superpowers/plans/2026-07-04-automations-oss-persistence.md Task 19).
 * Guarded by FLOWLET_DRILL so the demo's normal `next dev`/`next start`
 * behavior is completely untouched.
 *
 * Passes the SAME `flowletOptions` object the route uses (./flowlet/
 * handler-options.ts) to `startFlowletScheduler()` — required so the
 * scheduler's world and the route's world are the same one (see that file's
 * doc comment, and packages/flowlet-next/src/handler.ts's BootRegistry
 * comment: two different option objects land on two SEPARATE assembled
 * worlds, and only one of them gets its scheduler started).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.FLOWLET_DRILL === "1") {
    const [{ startFlowletScheduler }, { flowletOptions }] = await Promise.all([
      import("@flowlet/next"),
      import("@/flowlet/handler-options"),
    ]);
    startFlowletScheduler(flowletOptions);
  }
}
