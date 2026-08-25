/**
 * The TTL sweep: expired parked BYO calls and stranded approvals, on one pass
 * and one cadence.
 */
import { log } from "@vendoai/core";
import type { VendoComposition } from "./compose-context.js";

const SWEEP_TIMER = Symbol.for("vendo.background-ttl-sweep");

/** Arm the newest composition's background sweep and retire the previous one -
 *  ADOPT, never duplicate (#1250). Next dev re-evaluates route modules on
 *  every recompile, and each evaluation arms its own composition's sweep; after
 *  hours of recompiles a dev server carried dozens of live intervals, all
 *  hitting the hosted store with no browser open (field: linkwarden
 *  2026-08-13). The ticker half of the same report ships this exact pattern
 *  (`armDevTicker`): arming stops the predecessor's interval and starts the
 *  newcomer's, keeping exactly one sweep, bound to the composition actually
 *  serving requests. The slot rides globalThis via Symbol.for so it survives
 *  module re-evaluation. */
export function armBackgroundSweep(start: () => () => void, host: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>): void {
  const previousStop = host[SWEEP_TIMER];
  if (typeof previousStop === "function") (previousStop as () => void)();
  host[SWEEP_TIMER] = start();
}

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
      let sweepTimer: ReturnType<typeof setInterval> | undefined;
      // Adopt, never duplicate (#1250): a re-armed sweep stops the previous
      // composition's interval before starting this one.
      armBackgroundSweep((): (() => void) => {
        sweepTimer = setInterval(() => {
          runSweep().catch((error: unknown) => {
            log({
              code: "vendo.ttl-sweep-retry",
              level: "warn",
              message: `[vendo] TTL sweep failed; will retry next interval: ${error instanceof Error ? error.message : String(error)}`,
            });
          });
        }, sweepConfig.intervalMs);
        (sweepTimer as unknown as { unref?: () => void }).unref?.();
        return (): void => {
          if (sweepTimer !== undefined) clearInterval(sweepTimer);
        };
      });
      const closeStore = store.close.bind(store);
      store.close = async (): Promise<void> => {
        if (sweepTimer !== undefined) clearInterval(sweepTimer);
        await closeStore();
      };
    };
  }
  return { runSweep, sweepEnabled, startBackgroundSweep };
};
