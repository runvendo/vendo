/**
 * THE read of the env knob that repoints Vendo at a different console.
 *
 * `VENDO_CONSOLE_URL` names OUR origin — the console, `https://console.vendo.run`.
 * Its old spelling, `VENDO_CLOUD_URL`, read like "the URL of my cloud deployment"
 * sitting one line under `VENDO_BASE_URL`, which is the host's OWN public URL, so
 * the two got swapped: point `VENDO_CLOUD_URL` at your app and every Cloud adapter
 * quietly calls your app instead of the console.
 *
 * Both names work — renaming an env var must never stop a running deployment from
 * booting. The new name wins when both are set, and the old one says so ONCE per
 * process (a boot-time pointer; several of these callers run per turn).
 */
import { log } from "./log.js";

/** Guarded, because core is bundled for browser and edge targets. */
const processEnv = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/** A blank value is the same misconfiguration as an unset one, never a console at "". */
const configured = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

let announced = false;

/**
 * The operator-configured console origin, or `undefined` to leave the caller's
 * own default in place — callers keep their defaults so this stays a pure read.
 */
export function consoleUrlFromEnv(
  env: Record<string, string | undefined> = processEnv(),
): string | undefined {
  const current = configured(env["VENDO_CONSOLE_URL"]);
  if (current !== undefined) return current;
  const legacy = configured(env["VENDO_CLOUD_URL"]);
  if (legacy !== undefined && !announced) {
    announced = true;
    log({
      code: "core.env-renamed",
      level: "warn",
      message:
        "[vendo] VENDO_CLOUD_URL is the old name for VENDO_CONSOLE_URL — it still works, "
        + "but rename it: VENDO_CONSOLE_URL is the Vendo console's origin, VENDO_BASE_URL is your app's.",
    });
  }
  return legacy;
}
