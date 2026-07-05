/**
 * `startVendoScheduler()` — the long-lived-Node boot hook that makes
 * durable schedules fire WITHOUT any client visiting the app. Wire it from
 * Next.js instrumentation.ts (the CLI codemod does this):
 *
 *   export async function register() {
 *     if (process.env.NEXT_RUNTIME === "nodejs") {
 *       const { startVendoScheduler } = await import("@vendoai/next");
 *       startVendoScheduler();
 *     }
 *   }
 *
 * It assembles (or reuses — first-wins, see handler.ts BootRegistry) the
 * process-wide Vendo state and starts the in-process scheduler's unref'd
 * timer. Idempotent: calling it again is a no-op.
 *
 * `VENDO_SCHEDULER=external` disables the internal timer entirely for
 * serverless/multi-instance deploys — schedules then fire only via an
 * external cron POSTing /tick (with `authorization: Bearer
 * <VENDO_TICK_SECRET>`).
 */
import { bootRegistry, ensureVendoState } from "./fetch-handler.js";
import type { VendoHandlerOptions } from "./options.js";

export function startVendoScheduler(options: VendoHandlerOptions = {}): void {
  if (process.env["VENDO_SCHEDULER"] === "external") return;
  const registry = bootRegistry();
  if (registry.schedulerStarted) return;
  registry.schedulerStarted = true;
  void ensureVendoState(options)
    .then((state) => state.world?.scheduler.start())
    .catch((err: unknown) => {
      // Release the latch so a later call can retry instead of wedging the
      // scheduler off forever on a transient boot blip.
      registry.schedulerStarted = false;
      console.error(
        "[vendo] scheduler boot failed — schedules will not fire until a retry succeeds:",
        err,
      );
    });
}
