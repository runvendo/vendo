import type { LanguageModel } from "ai";
import { migrateModelSeats, seatConflict, VendoError, type ResolvedModels } from "@vendoai/core";
import { vendoModel, type VendoModelOptions } from "#dev-creds/model";

/**
 * The `models` block on createVendo (models spec 2026-07-22, DX surface 3):
 * one key per slot, valued by a model-name string (resolved through
 * vendoModel's credential ladder — VERBATIM passthrough, per-rung defaults)
 * or an explicit ai-SDK LanguageModel object (wins as-is). Supersedes the
 * deprecated top-level `model` and `paint.model` knobs; `paint.disabled`
 * survives as the single-lane switch. `judge` is consumed by
 * bindVendoModelSlots (see dev-creds/model.ts) — composition binds it, per
 * createVendo instance, onto the model of a judge the host wired from a
 * string, i.e. vendoAutoJudge({ model: vendoModel("vendo-judge") }).
 */
export interface ModelsConfig {
  /** Build contract §4's seat vocabulary. A seat is a JOB, not a model. These
   *  are additive: the legacy slot names below keep working for one minor, and
   *  `migrateModelSeats` (core) maps them on, so a half-migrated config still
   *  composes. Where both name one seat, the SEAT wins — a host mid-migration
   *  should get the new key they just wrote, not the old one they forgot to
   *  delete. */
  default?: string | LanguageModel;
  reviewer?: string | LanguageModel;
  /** The knowledge check's cheap/fast model. Its own seat: pinning the model
   *  that GRADES answers must never repoint the one that ANSWERS. */
  verifier?: string | LanguageModel;
  fill?: string | LanguageModel;
  /** @deprecated superseded by `default` (still functional for one minor). */
  agent?: string | LanguageModel;
  /** @deprecated superseded by `fill` (still functional for one minor). */
  paint?: string | LanguageModel;
  judge?: string | LanguageModel;
  /** K15 — the knowledge tool's evidence check (a cheap/fast model reading the
      retrieved passages before the tool returns them). Its own slot beside
      `judge`: pinning the model that GRADES answers must not silently repoint
      the one that GATES them. Unset = the family fast pick on whatever rung
      the host's credentials resolve to; `VENDO_KNOWLEDGE_VERIFY=off` turns the
      check off entirely. */
  knowledgeVerifier?: string | LanguageModel;
}

export interface ResolveModelsInput {
  /** @deprecated superseded by models.agent (still functional). */
  model?: LanguageModel;
  /** @deprecated model half superseded by models.paint; `disabled` stays. */
  paint?: { model?: LanguageModel; disabled?: boolean };
  models?: ModelsConfig;
  /** A model named by a harness's own options. Build contract §4 makes it a BOOT
   *  ERROR for this and `models.default` to both be set: two places naming the
   *  model that thinks is ambiguous, and guessing would silently ignore one. */
  harnessOptionModel?: string | LanguageModel;
}

export interface ComposedModelSlots {
  /** The one model the agent and apps blocks consume, plus the /status venue:
   *  "custom" (host-passed object) or "ladder" (env-resolved, incl. strings). */
  agent: { model: LanguageModel; venue: "custom" | "ladder" };
  /** The apps-block paint knob, post-precedence. Undefined = engine falls
   *  back to the agent model (today's explicit-model behavior). */
  paint: { model?: LanguageModel; disabled?: boolean } | undefined;
  /** The knowledge check's cheap/fast model (contract amendment 2026-07-30 — its
   *  own seat, never the agent's). Undefined = the family fast pick. */
  verifier: { model: LanguageModel } | undefined;
  /** Build contract §4's `ResolvedModels` — every seat filled, which is what a
   *  `Turn` carries. Same resolution order as the slots above, stated once: an
   *  explicit seat, else `default`. Borrowing `default` is the contract's own
   *  fallback ("seat → default → the env credential ladder"), and `default`
   *  itself already rode the ladder, so no seat can be unfilled. */
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

/** Resolve the models block + deprecated aliases into the composed slots.
 *  Precedence per slot: explicit model object → (env pins, inside the
 *  ladder) → models string → per-rung default. Paint invisibility: when the
 *  agent slot rides the ladder and no paint model was configured, the paint
 *  lane composes the family fast pick (vendo-paint on Cloud, the provider's
 *  fast model on BYO rungs); when the host passed an explicit agent model,
 *  paint falls back to that model exactly as before. */
export function resolveModels(config: ResolveModelsInput, makeModel: MakeModel = vendoModel): ComposedModelSlots {
  validateSlot("default", config.models?.default);
  validateSlot("reviewer", config.models?.reviewer);
  validateSlot("fill", config.models?.fill);
  validateSlot("agent", config.models?.agent);
  validateSlot("paint", config.models?.paint);
  validateSlot("judge", config.models?.judge);
  validateSlot("verifier", config.models?.verifier);
  validateSlot("knowledgeVerifier", config.models?.knowledgeVerifier);

  // Collapse both vocabularies onto seats once, here, so the precedence below
  // never has to know which spelling a host used.
  const seats = migrateModelSeats<LanguageModel>(config.models ?? {});
  // Build contract §4's boot error, pointed at the collision a real host can
  // ACTUALLY create. It used to guard `harnessOptionModel`, which no production
  // path sets, while the deprecated top-level `model` colliding with
  // `models.default` resolved last-write-wins — silently ignoring one of two
  // explicit instructions. Two knobs naming one seat is ambiguous whichever
  // spellings they use, so refuse instead of guessing.
  // Checked against the RAW keys, not the collapsed seats, because the two
  // vocabularies carry different promises. `models.agent` SUPERSEDING the
  // deprecated top-level `model` is shipped, documented, tested behaviour — the
  // whole point of the shim is that a host mid-migration can leave the old key in
  // place. The NEW seat names have no such promise, so `model` + `models.default`
  // is two instructions for one seat with nothing to disambiguate them, and
  // guessing is what made a host's explicit choice disappear.
  const collisions: Array<[string, string]> = [
    ...(config.model !== undefined && config.models?.default !== undefined
      ? [["model", "models.default"] as [string, string]] : []),
    ...(config.paint?.model !== undefined && config.models?.fill !== undefined
      ? [["paint.model", "models.fill"] as [string, string]] : []),
  ];
  if (collisions.length > 0) {
    const detail = collisions.map(([left, right]) => `\`${left}\` and \`${right}\``).join("; ");
    throw new VendoError(
      "validation",
      `Two knobs set the same model seat: ${detail}. Remove one — the deprecated key or the seat.`,
    );
  }
  const conflict = seatConflict<LanguageModel>({
    ...(config.harnessOptionModel === undefined ? {} : { harnessOptionModel: config.harnessOptionModel }),
    seats,
  });
  if (conflict !== undefined) throw new VendoError("validation", conflict);

  const agentConfigured = seats.default ?? config.model;
  const agent: ComposedModelSlots["agent"] = agentConfigured === undefined
    ? { model: makeModel(undefined, { slot: "agent" }), venue: "ladder" }
    : typeof agentConfigured === "string"
      ? { model: makeModel(agentConfigured, { slot: "agent" }), venue: "ladder" }
      : { model: agentConfigured, venue: "custom" };

  const disabled = config.paint?.disabled;
  const paintConfigured = seats.fill ?? config.paint?.model;
  const paintModel = disabled === true
    ? undefined // no model behind a disabled lane
    : typeof paintConfigured === "string"
      ? makeModel(paintConfigured, { slot: "paint" })
      : paintConfigured
        ?? (agent.venue === "ladder" ? makeModel(undefined, { slot: "paint" }) : undefined);

  const paint = paintModel === undefined && disabled === undefined
    ? undefined
    : {
        ...(paintModel === undefined ? {} : { model: paintModel }),
        ...(disabled === undefined ? {} : { disabled }),
      };

  // The verifier seat resolves independently of `agent` — that independence IS
  // the amendment: a host setting only the knowledge check's model must not
  // change which model answers users.
  const verifierConfigured = seats.verifier;
  const verifier = verifierConfigured === undefined
    ? undefined
    : {
        model: typeof verifierConfigured === "string"
          ? makeModel(verifierConfigured, { slot: "knowledgeVerifier" })
          : verifierConfigured,
      };

  // Build contract §4's seat record, resolved from the SAME values above so the
  // model a seat names can never disagree with the model the matching slot got.
  // A seat nobody set borrows `default`; that is the contract's fallback, not a
  // guess, and it is why every seat is non-optional.
  const seat = (
    configured: string | LanguageModel | undefined,
    options?: VendoModelOptions,
  ): LanguageModel =>
    configured === undefined
      ? agent.model
      : typeof configured === "string"
        ? makeModel(configured, options)
        : configured;

  const resolvedSeats: ResolvedModels<LanguageModel> = {
    default: agent.model,
    // `fill` already has its own precedence (including the family fast pick when
    // the default rides the ladder), so take the resolved value rather than
    // re-deriving it and risking two answers for one seat.
    fill: paintModel ?? agent.model,
    verifier: verifier?.model ?? agent.model,
    // No `slot` for the reviewer: the ladder's slots are the ones with an env pin
    // and a Cloud family name, and `reviewer` has neither yet — so a reviewer
    // model named as a string rides `inferSlot`, exactly like any other name.
    reviewer: seat(seats.reviewer),
    judge: seat(seats.judge, { slot: "judge" }),
  };

  return { agent, paint, verifier, seats: resolvedSeats };
}
