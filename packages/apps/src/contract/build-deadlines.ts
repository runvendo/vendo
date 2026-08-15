/**
 * The ONE source of truth for the app-build deadlines (speed-core lane).
 * Before this module the server build watchdog (4 min, packages/apps) and the
 * UI polling cutoff (5 min, packages/ui) were two unrelated literals — a slow
 * build could die silently in the gap, and retuning one side desynced the
 * other. The UI cutoff always STRICTLY exceeds the effective watchdog, so the
 * watchdog's terminal buildFailed record (with its honest reason and retry
 * affordance) lands before the client gives up with the generic deadline beat.
 */

export const BUILD_WATCHDOG_MS = 4 * 60_000;

/** How long the UI keeps polling past the watchdog: covers the watchdog's
 *  persist + one poll cadence with generous slack. */
const UI_DEADLINE_MARGIN_MS = 60_000;

export const APP_BUILD_UI_DEADLINE_MS = BUILD_WATCHDOG_MS + UI_DEADLINE_MARGIN_MS;

/** The effective watchdog window: the `VENDO_APP_BUILD_WATCHDOG_MS` operator
 *  override (test seam and escape hatch) where a `process` env is visible —
 *  this module also runs on edge/Worker and browser targets with no `process`
 *  global, which simply get the constant. */
export const effectiveBuildWatchdogMs = (): number => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const configured = Number(env?.["VENDO_APP_BUILD_WATCHDOG_MS"]);
  return Number.isFinite(configured) && configured > 0 ? configured : BUILD_WATCHDOG_MS;
};

/** The effective UI polling cutoff: derives from the effective watchdog, so
 *  the strict cutoff > watchdog invariant holds under the env override too. */
export const effectiveAppBuildUiDeadlineMs = (): number =>
  effectiveBuildWatchdogMs() + UI_DEADLINE_MARGIN_MS;

/** Whether `AppDocument.building` still names a build in flight. Time-bounded
 *  for the placement read's reason: past the window either the watchdog landed
 *  a terminal record or the build's process died, and a flag that never cleared
 *  would leave the app unmountable forever. */
export const buildInFlight = (building: string | undefined): boolean =>
  building !== undefined && Date.now() - Date.parse(building) < effectiveAppBuildUiDeadlineMs();
