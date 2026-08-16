/**
 * Capability-aware parameters for every model call the generation engine makes.
 *
 * WHAT BROKE. The Claude 5 line (and Opus 4.7/4.8 before it) REMOVED the
 * sampling parameters. A request carrying `temperature`, `top_p`, or `top_k`
 * is rejected outright:
 *
 *     400 invalid_request_error — "`temperature` is deprecated for this model."
 *
 * (verified live against api.anthropic.com on 2026-07-26: `claude-opus-5` +
 * `temperature: 0` → 400, the same request without it → 200, and
 * `claude-sonnet-4-6` + `temperature: 0` → 200). The engine hardcoded
 * `temperature: 0` at every model call, so a host that configured any Claude 5
 * model could not generate AT ALL — every create, edit, repair, and verify
 * pass failed on the first request.
 *
 * The same id split drives a second, quieter failure. `@ai-sdk/anthropic` is a
 * HOST-supplied peer, not something this package pins for the host: a provider
 * whose model registry predates the 5 line treats those ids as unknown and
 * silently defaults `max_tokens` to 4096, truncating generated wire mid-app
 * with no error and no warning. A silently truncated app is worse than a loud
 * failure, and it has exactly the same trigger as the sampling rejection (an id
 * the sampling-era registry does not know), so both fixes travel together here.
 *
 * WHY MODEL-ID MATCHING, and not the alternatives:
 *
 *   - try-and-fallback on the 400 would burn a wasted round trip on every
 *     first call, and the engine's main path is `streamText`, which does NOT
 *     throw provider errors — the rejection arrives as a silently empty text
 *     stream, so there is nothing dependable to catch. It would also make the
 *     test suite depend on live provider behaviour.
 *   - explicit host configuration would leave every existing host broken by
 *     default, and force each one to learn a new knob just to restate a fact
 *     about the model that we already know.
 *   - id matching is deterministic, needs no configuration, costs no round
 *     trip, and is unit-testable offline. Its one risk is an id we do not
 *     recognise, which the rule below resolves in the safe direction.
 *
 * THE RULE (this is where it lives): sampling support is an ALLOWLIST of the
 * Claude families that predate the removal. Anthropic only ever moves ids INTO
 * the rejecting set, so an unrecognised `claude-*` id is treated as rejecting.
 * Guessing "rejects" on a model that actually accepts costs determinism we were
 * never promised — `temperature: 0` has never guaranteed identical output —
 * while guessing "accepts" on a model that rejects is a hard 400 and a total
 * generation outage. Non-Claude models are left completely untouched: every
 * other provider still takes sampling, and this must not regress them.
 */
import type { LanguageModel } from "ai";

/**
 * Output cap applied to models whose ids a sampling-era provider registry does
 * not recognise. It has to clear the provider's silent 4096 default by enough
 * to hold adaptive thinking plus a full generated app document — thinking is on
 * by default across the Claude 5 line and `max_tokens` caps thinking and
 * response text together.
 *
 * 64K, not 128K: this is a ceiling rather than an allocation, so an unreached
 * cap costs nothing, but a cap ABOVE the model's true limit is itself a 400.
 * 128K is the Claude 5 ceiling, while the Haiku tier caps at 64K — so 64K is
 * the largest value that stays valid for a small-output model we have not seen
 * yet, which is precisely the case this constant exists to cover.
 */
export const UNKNOWN_MODEL_MAX_OUTPUT_TOKENS = 64_000;

/**
 * Claude families that still accept sampling parameters: the whole 3.x line,
 * and the 4.0 through 4.6 releases. The `2025` alternative catches the
 * undashed dated snapshots (`claude-opus-4-20250514`), whose minor segment is
 * a date rather than a version.
 *
 * Opus 4.7 and 4.8, and the entire 5 line (opus / sonnet / fable / mythos), are
 * deliberately ABSENT — they reject sampling, and so does anything else that
 * fails to match, which is what keeps this rule correct for models that do not
 * exist yet.
 */
const SAMPLING_CLAUDE = /^claude-(?:3-|(?:opus|sonnet|haiku)-4-(?:0|1|5|6|2025))/;

/**
 * The `claude-…` token inside a model id, however the id is spelled: first
 * party (`claude-opus-5`), AI-SDK gateway (`anthropic/claude-opus-5`), or
 * Bedrock (`anthropic.claude-opus-5`). Matching the token rather than the
 * provider string keeps this correct across all three spellings without
 * depending on a provider id that middleware is free to override.
 */
const claudeToken = (modelId: string): string | undefined =>
  /claude-[a-z0-9-]*/.exec(modelId.toLowerCase())?.[0];

/** `LanguageModel` is `string | LanguageModelV2 | LanguageModelV3`; only the
 *  object forms carry `modelId`. */
const modelIdOf = (model: LanguageModel): string =>
  typeof model === "string" ? model : model.modelId;

/**
 * The Cloud gateway's model family — literal ids the console maps to concrete
 * models SERVER-SIDE (dev-creds CLOUD_MODEL: `vendo`, `vendo-apps`,
 * `vendo-review`, `vendo-judge`, `vendo-extract`; `vendo-env` is the lazy
 * ladder wrapper's placeholder identity). They ride the STOCK
 * @ai-sdk/anthropic provider, whose
 * capability registry does not know them — without an explicit cap it silently
 * limits max_tokens to 4096, truncating a generated app document mid-wire
 * (field: linkwarden 2026-08-08 — nothing painted, no row landed, every
 * row-scoped verb answered not-found). The mapped models are the Claude 5
 * line, so sampling is rejected too. A new family name must join this set the
 * day the console starts serving it.
 */
const VENDO_GATEWAY_FAMILY = /^vendo(?:-(?:apps|review|judge|extract|env))?$/;

/** Whether this model accepts `temperature` / `top_p` / `top_k`. Non-Claude
 *  models always do; Claude models do only on the pre-removal families; the
 *  vendo Cloud gateway family maps to the Claude 5 line server-side, so it
 *  rejects (and needs the explicit output cap above all). */
export const acceptsSamplingParams = (model: LanguageModel): boolean => {
  const modelId = modelIdOf(model);
  if (VENDO_GATEWAY_FAMILY.test(modelId.toLowerCase())) return false;
  const token = claudeToken(modelId);
  return token === undefined || SAMPLING_CLAUDE.test(token);
};

/** Parameters to spread into a `generateText` / `streamText` call. */
export interface ModelCallParams {
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * The engine's OWN determinism default for a model call. Spread this into
 * every `generateText` / `streamText` call generation makes.
 *
 * On a model that takes sampling this is exactly today's behaviour —
 * `temperature: 0`, no output cap, so currently-supported models are not
 * regressed in any way. On a model that rejects sampling the temperature is
 * dropped (it is the engine's own preference, not a caller's instruction) and
 * an explicit output cap is set so an unaware provider cannot silently fall
 * back to 4096.
 */
export const modelCallParams = (model: LanguageModel): ModelCallParams =>
  acceptsSamplingParams(model)
    ? { temperature: 0 }
    : { maxOutputTokens: UNKNOWN_MODEL_MAX_OUTPUT_TOKENS };
