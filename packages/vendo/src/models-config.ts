import type { LanguageModel } from "ai";
import { SEATS, seatConflict, VendoError, type ResolvedModels, type Seat } from "@vendoai/core";
import { vendoModel, type VendoModelOptions } from "#dev-creds/model";

/**
 * The `models` block on createVendo (models spec 2026-07-22, DX surface 3):
 * one key per SEAT, valued by a model-name string (resolved through
 * vendoModel's credential ladder — VERBATIM passthrough, per-rung defaults)
 * or an explicit ai-SDK LanguageModel object (wins as-is). `judge` is
 * additionally consumed by bindVendoModelSlots (see dev-creds/model.ts) —
 * composition binds it, per createVendo instance, onto the model of a judge
 * the host wired from a string, i.e. vendoAutoJudge({ model:
 * vendoModel("vendo-judge") }).
 */
export interface ModelsConfig {
  /** Build contract §4's seat vocabulary — the ONE spelling per seat. A seat is
   *  a JOB, not a model: the same model may fill several, and swapping one never
   *  renames the others. */
  default?: string | LanguageModel;
  apps?: string | LanguageModel;
  review?: string | LanguageModel;
  judge?: string | LanguageModel;
}

export interface ResolveModelsInput {
  models?: ModelsConfig;
  /** A model named by a harness's own options. Build contract §4 makes it a BOOT
   *  ERROR for this and `models.default` to both be set: two places naming the
   *  model that thinks is ambiguous, and guessing would silently ignore one. */
  harnessOptionModel?: string | LanguageModel;
}

export interface ComposedModelSlots {
  /** The `default` seat's model, plus the /status venue: "custom" (host-passed
   *  object) or "ladder" (env-resolved, incl. strings). Kept beside `seats`
   *  because the venue is the only thing a seat record cannot say. */
  agent: { model: LanguageModel; venue: "custom" | "ladder" };
  /** Build contract §4's `ResolvedModels` — every seat filled, which is what a
   *  `Turn` carries, so a reader never has to know what an unset seat means. */
  seats: ResolvedModels<LanguageModel>;
}

type MakeModel = (name?: string, options?: VendoModelOptions) => LanguageModel;

function validateSlot(slot: string, value: string | LanguageModel | undefined): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (value.trim().length > 0) return;
    throw new VendoError("validation", `models.${slot} must be a non-blank model name string or an ai-SDK LanguageModel`);
  }
  if (typeof value === "object" && value !== null) return;
  throw new VendoError("validation", `models.${slot} must be a model-name string or an ai-SDK LanguageModel object`);
}

/** Resolve the models block into the composed seats. Precedence per seat:
 *  explicit model object → (env pins, inside the ladder) → models string →
 *  per-rung default. An UNSET seat borrows `default`, and what that means
 *  depends on how `default` itself resolved: a host-passed model object is the
 *  host's whole answer, so every seat borrows the object; a `default` that rode
 *  the ladder means the seat rides it too, under its own slot — which is what
 *  gives each seat its own Cloud family id (`vendo-apps`, `vendo-review`) and
 *  lets the reading seats take the provider's fast pick on a BYO rung. */
export function resolveModels(config: ResolveModelsInput, makeModel: MakeModel = vendoModel): ComposedModelSlots {
  const seats = config.models ?? {};
  // One spelling per seat, so a key that is not a seat is refused rather than
  // silently dropped — the same refusal `REMOVED_CONFIG_KEYS` gives a removed
  // top-level key. TypeScript already rejects it; this is for the JavaScript
  // host, and for a config still spelling the removed `agent`/`paint`/`fill`/
  // `reviewer` slots.
  for (const [key, value] of Object.entries(seats)) {
    if (value === undefined) continue;
    if (!SEATS.includes(key as Seat)) {
      throw new VendoError("validation", `models.${key} is not a model seat — the seats are ${SEATS.join(", ")}`);
    }
    validateSlot(key, value);
  }

  const conflict = seatConflict<LanguageModel>({
    ...(config.harnessOptionModel === undefined ? {} : { harnessOptionModel: config.harnessOptionModel }),
    seats,
  });
  if (conflict !== undefined) throw new VendoError("validation", conflict);

  const agent: ComposedModelSlots["agent"] = seats.default === undefined
    ? { model: makeModel(undefined, { slot: "agent" }), venue: "ladder" }
    : typeof seats.default === "string"
      ? { model: makeModel(seats.default, { slot: "agent" }), venue: "ladder" }
      : { model: seats.default, venue: "custom" };

  const seat = (
    configured: string | LanguageModel | undefined,
    slot: VendoModelOptions["slot"],
  ): LanguageModel =>
    typeof configured === "string"
      ? makeModel(configured, { slot })
      : configured
        ?? (agent.venue === "ladder" ? makeModel(undefined, { slot }) : agent.model);

  return {
    agent,
    seats: {
      default: agent.model,
      apps: seat(seats.apps, "apps"),
      review: seat(seats.review, "review"),
      judge: seat(seats.judge, "judge"),
    },
  };
}
