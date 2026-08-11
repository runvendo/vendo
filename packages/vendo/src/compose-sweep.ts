/**
 * The TTL sweep: expired parked BYO calls and stranded approvals, on one pass
 * and one cadence.
 */
import { log } from "@vendoai/core";
import type { VendoComposition } from "./compose-context.js";

/** The sweep pass, and the unref'd timer that drives it on a long-lived host. */
export const composeSweep = (composition: VendoComposition): Pick<VendoComposition,
  "runSweep" | "sweepEnabled" | "startBackgroundSweep"> => {
  const { store, guard, byoApprovals, parkedCallTtlMs, sweepConfig, sweepNow } = composition;
  const runSweep = async (): Promise<void> => {
    // Existing-agents Lane B — expire orphaned parked BYO calls on the same
    // cadence (deny path, idempotent); disabled by parkedCallTtlMs 0.
    if (parkedCallTtlMs > 0) {
      await byoApprovals.sweepExpired(parkedCallTtlMs, sweepNow());
      // Spec 2026-07-20 (#5): the same backstop over the general approvals
      // collection. Chat approvals are abandoned on the next thread turn and
      // BYO parked calls swept above, but away/automation/app approvals and
      // approvals stranded by a mid-stream turn failure have no resuming turn —
      // this TTL sweep denies them (idempotent) so the queue self-heals instead
      // of piling up. Shares the parked-call TTL; disabled by the same 0.
      if (guard.sweepExpiredApprovals !== undefined) {
        try {
          await guard.sweepExpiredApprovals(parkedCallTtlMs, sweepNow());
        } catch (error) {
          log({
            code: "vendo.approval-ttl-sweep-failed",
            level: "error",
            message: "[vendo] approval TTL sweep failed",
            data: {
              detail: { error: error instanceof Error ? error.message : String(error) },
            },
          });
        }
      }
    }
  };
  const sweepEnabled = parkedCallTtlMs > 0;
  // Long-lived hosts also get a background sweep on an UNREF'd timer (automations
  // engine pattern) so an idle process still reclaims what no request would;
  // unref'd means it never keeps the event loop alive. Torn down with the store.
  let startBackgroundSweep = composition.startBackgroundSweep;
  if (sweepEnabled) {
    // Armed by the ready() latch above, NOT at construction: timers are
    // illegal in Workers global scope, and a process that never serves a
    // request has nothing to sweep.
    startBackgroundSweep = (): void => {
      const sweepTimer = setInterval(() => {
        runSweep().catch((error: unknown) => {
          log({
            code: "vendo.ttl-sweep-retry",
            level: "warn",
            message: `[vendo] TTL sweep failed; will retry next interval: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
      }, sweepConfig.intervalMs);
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
