/**
 * `startFlowletScheduler()` — the long-lived-Node boot hook that makes
 * durable schedules fire WITHOUT any client visiting the app. Wire it from
 * Next.js instrumentation.ts (the CLI codemod does this):
 *
 *   export async function register() {
 *     if (process.env.NEXT_RUNTIME === "nodejs") {
 *       const { startFlowletScheduler } = await import("@flowlet/next");
 *       startFlowletScheduler();
 *     }
 *   }
 *
 * It assembles (or reuses — first-wins, see handler.ts BootRegistry) the
 * process-wide Flowlet state and starts the in-process scheduler's unref'd
 * timer. Idempotent: calling it again is a no-op.
 *
 * `FLOWLET_SCHEDULER=external` disables the internal timer entirely for
 * serverless/multi-instance deploys — schedules then fire only via an
 * external cron POSTing /tick (with `authorization: Bearer
 * <FLOWLET_TICK_SECRET>`).
 */
import { bootRegistry, ensureFlowletState } from "./fetch-handler";
import type { FlowletHandlerOptions } from "./options";

export function startFlowletScheduler(options: FlowletHandlerOptions = {}): void {
  if (process.env["FLOWLET_SCHEDULER"] === "external") return;
  const registry = bootRegistry();
  if (registry.schedulerStarted) return;
  registry.schedulerStarted = true;
  void ensureFlowletState(options)
    .then((state) => state.world?.scheduler.start())
    .catch((err: unknown) => {
      // Release the latch so a later call can retry instead of wedging the
      // scheduler off forever on a transient boot blip.
      registry.schedulerStarted = false;
      console.error(
        "[flowlet] scheduler boot failed — schedules will not fire until a retry succeeds:",
        err,
      );
    });
}
