import { runInit, type InitOptions } from "./init.js";

/**
 * `vendo refresh` — the catch-up command in the init / refresh / sync triad.
 *
 * `init` is the beginning (run once to set up); `refresh` is the catch-up (run
 * whenever the app has grown; offers only what is new); `sync` is the automatic
 * in-between. `init` and `refresh` share ONE additive code path: this is a thin
 * mode selector over the shared init pipeline. Running it re-runs steps 1–4
 * against only-new candidates (the pipeline is already additive — kept theme,
 * gap-filled tools, only-unwrapped components, only-unanchored remix sites),
 * verifies wiring silently, and suppresses first-run onboarding text. It never
 * fails and never overwrites; all logic lives in `runInit`.
 */
export async function runRefresh(opts: InitOptions): Promise<number> {
  return runInit({ ...opts, mode: "refresh" });
}
