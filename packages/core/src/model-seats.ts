/** Build contract §4 — the model seats. A seat is a JOB, not a model: the
 *  same model may fill several, and swapping one never renames the others.
 *
 *  One seat per job that actually runs: `default` thinks (chat, compaction,
 *  subagents, automations), `apps` writes generated apps, `review` grades the
 *  finished ones, `judge` answers guard's run/ask/block. A seat nobody reads
 *  is a seat nobody can set correctly, which is why there are exactly four. */
export type Seat = "default" | "apps" | "review" | "judge";

/** Iteration order for the seats, so callers never hand-roll the list. */
export const SEATS: readonly Seat[] = ["default", "apps", "review", "judge"];

/**
 * Build contract §4's `ResolvedModels`: every seat filled.
 *
 * Generic over the model type instead of importing the ai-SDK's `LanguageModel`,
 * for the same reason `threadMessageStore` is generic — `@vendoai/core` carries
 * no `ai` dependency, and `scripts/dependency-guard.mjs` rejects adding one.
 * The umbrella instantiates it as `ResolvedModels<LanguageModel>`, so the shape
 * callers see is the contracted one.
 */
export type ResolvedModels<Model = unknown> = Readonly<Record<Seat, Model>>;

/**
 * What a `Turn` carries (agents spec 2026-08-04): any subset of the seats. A
 * seat is required only where a harness actually reads it — `claudeCode()`
 * reads none (its box brings its own inference) and `vendo()` thinks with
 * `default` — so demanding every seat from
 * every caller made hosts fabricate models nobody would call. Composition still
 * hands over a full `ResolvedModels` (it is assignable); a host driving the
 * runtime directly passes only what its harness reads. A harness that reads a
 * seat owns saying so loudly when it is missing.
 */
export type SeatModels<Model = unknown> = Readonly<Partial<Record<Seat, Model>>>;

/** What a host may set: any subset, each either a model or a name to resolve. */
export type SeatConfig<Model = unknown> = Partial<Record<Seat, Model | string>>;

/**
 * Build contract §4: **boot error** if a harness option sets a model AND
 * `models.default` is set for the same seat.
 *
 * Returns the message rather than throwing, so the caller decides whether this
 * is a boot failure or a config warning. Silence means no conflict.
 *
 * Why only `default`: a harness's `model` option names the model it thinks with,
 * which is the `default` seat. A judge or review seat is a different job, so
 * setting one alongside a harness option is not ambiguous and must not error.
 */
export function seatConflict<Model = unknown>(input: {
  harnessOptionModel?: Model | string;
  seats: SeatConfig<Model>;
}): string | undefined {
  if (input.harnessOptionModel === undefined) return undefined;
  if (input.seats.default === undefined) return undefined;
  return "A harness option and `models.default` both set a model for the default seat. "
    + "Remove one — either the harness's `model` option or `models.default`.";
}
