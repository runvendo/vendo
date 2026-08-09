/**
 * 02-store §4 (kill-list B3) — the TTL sweep: idle ephemeral sessions, expired
 * parked BYO calls, and stranded approvals, on one pass and one cadence.
 */
import type { VendoComposition } from "./compose-context.js";

/** The sweep pass, and the unref'd timer that drives it on a long-lived host. */
export const composeSweep = (composition: VendoComposition): Pick<VendoComposition,
  "runSweep" | "sweepEnabled" | "startBackgroundSweep"> => {
  const { store, guard, byoApprovals, parkedCallTtlMs } = composition;
  const { sessionsConfig, sessionNow, sessionOps, harnessTurns } = composition;
  // 02-store §4 (kill-list B3) TTL sweep: erase every idle ephemeral session's
  // disk rows, then cascade each swept subject into the agent's in-memory
  // threads (store-first — a concurrent request then fails closed at the store
  // rather than finding threads without store state). Disabled when ttlMs is 0.
  const runSweep = async (): Promise<void> => {
    // Existing-agents Lane B — expire orphaned parked BYO calls on the same
    // cadence (deny path, idempotent); disabled by parkedCallTtlMs 0.
    if (parkedCallTtlMs > 0) {
      await byoApprovals.sweepExpired(parkedCallTtlMs, sessionNow());
      // Spec 2026-07-20 (#5): the same backstop over the general approvals
      // collection. Chat approvals are abandoned on the next thread turn and
      // BYO parked calls swept above, but away/automation/app approvals and
      // approvals stranded by a mid-stream turn failure have no resuming turn —
      // this TTL sweep denies them (idempotent) so the queue self-heals instead
      // of piling up. Shares the parked-call TTL; disabled by the same 0.
      if (guard.sweepExpiredApprovals !== undefined) {
        try {
          await guard.sweepExpiredApprovals(parkedCallTtlMs, sessionNow());
        } catch (error) {
          console.error("[vendo] approval TTL sweep failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (sessionsConfig.ttlMs <= 0) return;
    for (const subject of await sessionOps.sweep(sessionsConfig.ttlMs, sessionNow())) {
      // D6 — ONE sweep. Both doors evict the SAME rows through the same
      // repository, so calling both would just delete twice; the harness door is
      // the one that also holds the per-thread tool loadouts to reclaim.
      await harnessTurns.evictSubject(subject);
    }
  };
  const sweepEnabled = sessionsConfig.ttlMs > 0 || parkedCallTtlMs > 0;
  // Long-lived hosts also get a background sweep on an UNREF'd timer (automations
  // engine pattern) so an idle process still reclaims sessions with no traffic;
  // unref'd means it never keeps the event loop alive. Torn down with the store.
  let startBackgroundSweep = composition.startBackgroundSweep;
  if (sweepEnabled) {
    // Armed by the ready() latch above, NOT at construction: timers are
    // illegal in Workers global scope, and a process that never serves a
    // request has nothing to sweep.
    startBackgroundSweep = (): void => {
      const sweepTimer = setInterval(() => {
        runSweep().catch((error: unknown) => {
          console.warn(`[vendo] session sweep failed; will retry next interval: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, sessionsConfig.sweepIntervalMs);
      (sweepTimer as unknown as { unref?: () => void }).unref?.();
      const closeStore = store.close.bind(store);
      store.close = async (): Promise<void> => {
        clearInterval(sweepTimer);
        await closeStore();
      };
    };
  }
  return { runSweep, sweepEnabled, startBackgroundSweep };
};
