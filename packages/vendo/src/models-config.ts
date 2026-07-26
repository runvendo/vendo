import type { LanguageModel } from "ai";
import { VendoError } from "@vendoai/core";
import { vendoModel, type VendoModelOptions } from "#dev-creds/model";

/**
 * The `models` block on createVendo (models spec 2026-07-22, DX surface 3):
 * one key per slot, valued by a model-name string (resolved through
 * vendoModel's credential ladder — VERBATIM passthrough, per-rung defaults)
 * or an explicit ai-SDK LanguageModel object (wins as-is). Supersedes the
 * deprecated top-level `model` and `paint.model` knobs; `paint.disabled`
 * survives as the single-lane switch. `judge` is consumed by
 * configureVendoModelSlots (see dev-creds/model.ts) — it only feeds a judge
 * the host wired from a string, i.e. vendoAutoJudge(vendoModel("vendo-judge")).
 */
export interface ModelsConfig {
  agent?: string | LanguageModel;
  paint?: string | LanguageModel;
  judge?: string | LanguageModel;
}

export interface ResolveModelsInput {
  /** @deprecated superseded by models.agent (still functional). */
  model?: LanguageModel;
  /** @deprecated model half superseded by models.paint; `disabled` stays. */
  paint?: { model?: LanguageModel; disabled?: boolean };
  models?: ModelsConfig;
}

export interface ResolvedModels {
  /** The one model the agent and apps blocks consume, plus the /status venue:
   *  "custom" (host-passed object) or "ladder" (env-resolved, incl. strings). */
  agent: { model: LanguageModel; venue: "custom" | "ladder" };
  /** The apps-block paint knob, post-precedence. Undefined = engine falls
   *  back to the agent model (today's explicit-model behavior). */
  paint: { model?: LanguageModel; disabled?: boolean } | undefined;
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
export function resolveModels(config: ResolveModelsInput, makeModel: MakeModel = vendoModel): ResolvedModels {
  validateSlot("agent", config.models?.agent);
  validateSlot("paint", config.models?.paint);
  validateSlot("judge", config.models?.judge);

  const agentConfigured = config.models?.agent ?? config.model;
  const agent: ResolvedModels["agent"] = agentConfigured === undefined
    ? { model: makeModel(undefined, { slot: "agent" }), venue: "ladder" }
    : typeof agentConfigured === "string"
      ? { model: makeModel(agentConfigured, { slot: "agent" }), venue: "ladder" }
      : { model: agentConfigured, venue: "custom" };

  const disabled = config.paint?.disabled;
  const paintConfigured = config.models?.paint ?? config.paint?.model;
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

  return { agent, paint };
}
