/**
 * The selectable model line for the Vendo lane — one source of truth for the
 * CLI, the cockpit picker, and the adapter.
 *
 * The per-model capability flags are load-bearing, not documentation. Verified
 * live against the Messages API on 2026-07-26:
 *
 *   - the Claude 5 line (Fable 5 / Opus 5 / Sonnet 5) REJECTS `temperature`
 *     with a 400 ("`temperature` is deprecated for this model"), and rejects
 *     thinking token budgets with a 400 pointing at `output_config.effort`;
 *   - Haiku 4.5 accepts `temperature` and a thinking budget but rejects
 *     `effort` ("This model does not support the effort parameter");
 *   - Sonnet 4.6 — the engine's shipped default — accepts all three.
 *
 * Because the engine hardcodes `temperature: 0` at every model call site
 * (packages/apps/src/generation/engine.ts, stages/verify.ts, stages/repair.ts),
 * selecting a Claude 5 model is impossible without the adapter stripping it —
 * see lanes/vendo.ts.
 */

export type ThinkingControl = "budget" | "effort";
export type EffortLevel = "low" | "medium" | "high";

export interface BenchModel {
  id: string;
  /** Short display label; also accepted by `--model`. */
  label: string;
  /** The engine's shipped default (lanes/vendo.ts DEFAULT_MODEL_ID). */
  productionDefault?: true;
  /** Whether the model accepts a `temperature` at all. */
  temperature: boolean;
  /** How this model expresses thinking depth (the two are mutually exclusive). */
  thinking: ThinkingControl;
}

export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high"];

export const MODELS: readonly BenchModel[] = [
  { id: "claude-fable-5", label: "Fable 5", temperature: false, thinking: "effort" },
  { id: "claude-opus-5", label: "Opus 5", temperature: false, thinking: "effort" },
  { id: "claude-sonnet-5", label: "Sonnet 5", temperature: false, thinking: "effort" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", productionDefault: true, temperature: true, thinking: "budget" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", temperature: true, thinking: "budget" },
];

/** What an untouched run measures — keep in sync with lanes/vendo.ts. */
export const PRODUCTION_MODEL: BenchModel =
  MODELS.find((model) => model.productionDefault) ?? (MODELS[0] as BenchModel);

/**
 * The output ceiling every selected model runs under. The engine never sets
 * `maxOutputTokens`, so the provider falls back to its own model registry —
 * which caps ids it doesn't recognise (the whole Claude 5 line, in
 * @ai-sdk/anthropic 3.0.12) at 4096 and truncates generated wire mid-app.
 * Pinning one number also keeps an A/B honest: both arms get the same ceiling.
 */
export const MAX_OUTPUT_TOKENS = 64_000;

/** Per-run model choice; absence on a RunRequest means the engine default. */
export interface RunModel {
  id: string;
  /** Only for models with `temperature: true`. */
  temperature?: number;
  /** Extended-thinking token budget; only for `thinking: "budget"` models. */
  thinkingBudget?: number;
  /** Thinking depth; only for `thinking: "effort"` models. */
  effort?: EffortLevel;
}

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Resolve by exact id or by display label ("Opus 5", "opus-5", "opus5"). */
export function findModel(idOrLabel: string): BenchModel | undefined {
  const wanted = normalize(idOrLabel);
  return MODELS.find((model) => normalize(model.id) === wanted || normalize(model.label) === wanted);
}

export function modelById(id: string | undefined): BenchModel {
  return (id === undefined ? undefined : MODELS.find((model) => model.id === id)) ?? PRODUCTION_MODEL;
}

/** For error messages and the CLI usage line. */
export function modelChoices(): string {
  return MODELS.map((model) => `${model.id} (${model.label})`).join(", ");
}

/**
 * The single validator behind the CLI, the cockpit control, and the adapter:
 * returns a human error, or undefined when the choice is runnable. Settings a
 * model rejects are an error, never a silent drop — a dropped knob would make
 * an A/B lie about what it measured.
 */
export function validateModelChoice(choice: RunModel): string | undefined {
  const spec = findModel(choice.id);
  if (!spec) return `unknown model "${choice.id}" — valid: ${modelChoices()}`;

  if (choice.temperature !== undefined) {
    if (!spec.temperature) {
      return `${spec.label} does not accept a temperature (the Claude 5 line removed it; use thinking effort instead)`;
    }
    if (!Number.isFinite(choice.temperature) || choice.temperature < 0 || choice.temperature > 1) {
      return `temperature must be between 0 and 1 (got ${choice.temperature})`;
    }
  }

  if (choice.thinkingBudget !== undefined) {
    if (spec.thinking !== "budget") {
      return `${spec.label} has no thinking token budget (the Claude 5 line replaced it with effort: ${EFFORT_LEVELS.join("|")})`;
    }
    if (!Number.isInteger(choice.thinkingBudget) || choice.thinkingBudget < 1024) {
      return `thinking budget must be an integer of at least 1024 tokens (got ${choice.thinkingBudget})`;
    }
  }

  if (choice.effort !== undefined) {
    if (spec.thinking !== "effort") {
      return `${spec.label} has no effort parameter — give it a thinking token budget instead`;
    }
    if (!EFFORT_LEVELS.includes(choice.effort)) {
      return `unknown effort "${choice.effort}" — valid: ${EFFORT_LEVELS.join("|")}`;
    }
  }

  return undefined;
}

/** One-line summary for the history rail and pane chrome. */
export function describeModel(choice: RunModel | undefined): string {
  if (!choice) return "default";
  const spec = findModel(choice.id);
  const parts = [spec?.label ?? choice.id];
  if (choice.temperature !== undefined) parts.push(`t${choice.temperature}`);
  if (choice.thinkingBudget !== undefined) parts.push(`think ${choice.thinkingBudget}`);
  if (choice.effort !== undefined) parts.push(choice.effort);
  return parts.join(" · ");
}
