/**
 * The Vendo lane: conductCreate driven directly against the HostFixture
 * surface — catalog + tools + shape cards + theme as GenerationDependencies,
 * the production defaults (no knobs overridden). NEVER throws, and neither
 * does the conductor: a refusal ("cannot") and an unreadable answer
 * ("failure") come back as VALUES, so the lane maps all three outcomes to a
 * LaneResult and only a genuine crash reaches the catch.
 *
 * The study signal on a successful app is the checking layer's `findings`
 * (severity · where · message) — what is still wrong with the app that
 * shipped.
 *
 * The model key comes from the repo-root .env (source-only: values are read
 * into process.env and never printed). The Anthropic provider resolves through
 * @vendoai/apps's own module space — genui-bench declares no model SDK.
 *
 * PER-RUN MODEL + SAMPLING (RunRequest.model). Three seams, only one of which
 * the engine owns:
 *
 *   - model id — a real GenerationDependencies seam: `deps.model` is whatever
 *     LanguageModel instance we hand it, so the id is just the provider call.
 *   - temperature / thinking — NOT a GenerationDependencies seam. The engine
 *     hardcodes `temperature: 0` at every call site and never sets
 *     providerOptions or maxOutputTokens, so per-run sampling rides the AI
 *     SDK's own model middleware (`wrapLanguageModel` + `transformParams`),
 *     which rewrites the outgoing provider call for every engine stage.
 *
 * The middleware is not a nicety: the Claude 5 line rejects `temperature`
 * outright (400), so without stripping the engine's hardcoded 0 those models
 * could not be selected at all. Absent RunRequest.model there is no wrapper —
 * an untouched run is byte-identical to what ships.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  conductCreate,
  type ConductedResult,
  type ConductorOptions,
  type GenerationDependencies,
  type HostToolInfo,
} from "@vendoai/apps";
import {
  printWire,
  VENDO_TREE_FORMAT,
  type AppDocument,
  type NormalizedCatalog,
  type ShapeType,
  type Tree,
} from "@vendoai/core";
import {
  MAX_OUTPUT_TOKENS,
  PRODUCTION_MODEL,
  findModel,
  validateModelChoice,
  type BenchModel,
  type RunModel,
} from "../runner/models";
import type { HostFixture, LaneAdapter, LaneResult, LaneRunOptions } from "../runner/types";

export interface VendoAdapterOverrides {
  /** Test seam: a conductor-shaped fake (default: the real conductCreate). */
  conduct?: (
    input: { prompt: string },
    deps: GenerationDependencies,
    options?: ConductorOptions,
  ) => Promise<ConductedResult>;
  /** Test seam: an injected model instance (default: Anthropic from root .env). */
  model?: GenerationDependencies["model"];
  /** Test seam: build a provider model for an id (default: Anthropic from root .env). */
  createModel?: (id: string) => GenerationDependencies["model"];
}

/** Keep in sync with runner/models.ts PRODUCTION_MODEL. */
const DEFAULT_MODEL_ID = PRODUCTION_MODEL.id;

/** Source-only root .env load (cli.ts pattern, duplicated because cli.ts runs
 *  its main on import): fills unset process.env keys, never prints values. */
function loadRootEnv(): void {
  let root: string;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return;
  }
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key as string] !== undefined) continue;
    process.env[key as string] = (raw as string).replace(/^(["'])(.*)\1$/, "$2");
  }
}

/** @vendoai/apps's own module space (the engine's provider deps) so this app
 *  declares no model SDK. import.meta.resolve is absent when tsx runs this
 *  file as CJS (the CLI path); createRequire is the everywhere-safe way. */
function requireFromApps(specifier: string): unknown {
  const appsEntry = createRequire(import.meta.url).resolve("@vendoai/apps");
  return createRequire(appsEntry)(specifier);
}

/** The real model: @ai-sdk/anthropic for the given id. */
function resolveAnthropicModel(id: string): GenerationDependencies["model"] {
  loadRootEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("ANTHROPIC_API_KEY missing — set it in the repo-root .env");
  }
  const { createAnthropic } = requireFromApps("@ai-sdk/anthropic") as {
    createAnthropic: (options: { apiKey: string }) => (id: string) => GenerationDependencies["model"];
  };
  return createAnthropic({ apiKey })(id);
}

/** The slice of the AI SDK's provider call options this lane rewrites. */
export interface ModelCallParams {
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Rewrite one outgoing provider call for the run's model choice. Pure, and
 * exported as the assertion point for lanes/vendo.test.ts.
 *
 * `temperature` is deleted rather than left alone when the model rejects it:
 * the engine hardcodes 0 and the Claude 5 line 400s on any temperature.
 */
export function transformModelParams<T extends ModelCallParams>(
  params: T,
  choice: RunModel,
  spec: BenchModel,
): T {
  const next: T = { ...params, maxOutputTokens: params.maxOutputTokens ?? MAX_OUTPUT_TOKENS };

  if (!spec.temperature) delete next.temperature;
  else if (choice.temperature !== undefined) next.temperature = choice.temperature;

  const anthropic: Record<string, unknown> = { ...next.providerOptions?.anthropic };
  if (choice.thinkingBudget !== undefined) {
    anthropic.thinking = { type: "enabled", budgetTokens: choice.thinkingBudget };
    // Anthropic forbids temperature alongside extended thinking.
    delete next.temperature;
  }
  if (choice.effort !== undefined) anthropic.effort = choice.effort;
  if (Object.keys(anthropic).length > 0) {
    next.providerOptions = { ...next.providerOptions, anthropic };
  }
  return next;
}

/** Wrap a provider model so every engine stage inherits the run's settings. */
function withRunSettings(
  base: GenerationDependencies["model"],
  choice: RunModel,
  spec: BenchModel,
): GenerationDependencies["model"] {
  const { wrapLanguageModel } = requireFromApps("ai") as {
    wrapLanguageModel: (options: { model: unknown; middleware: unknown }) => GenerationDependencies["model"];
  };
  return wrapLanguageModel({
    model: base,
    middleware: {
      specificationVersion: "v3",
      transformParams: ({ params }: { params: ModelCallParams }) =>
        Promise.resolve(transformModelParams(params, choice, spec)),
    },
  });
}

/** The model the engine will run on, honoring the per-run choice. */
function modelFor(
  choice: RunModel | undefined,
  overrides: VendoAdapterOverrides,
): GenerationDependencies["model"] {
  const create = overrides.createModel ?? resolveAnthropicModel;
  if (!choice) {
    // No per-run choice: exactly what ships (GENUI_BENCH_MODEL stays the
    // headless override), and no middleware in the path.
    return overrides.model ?? create(process.env.GENUI_BENCH_MODEL ?? DEFAULT_MODEL_ID);
  }
  const invalid = validateModelChoice(choice);
  if (invalid) throw new Error(invalid);
  const spec = findModel(choice.id) as BenchModel;
  return withRunSettings(overrides.model ?? create(spec.id), choice, spec);
}

/** The canonical printed wire of the final document (the conductor exposes no
 *  raw-stream tap; this is the same print the checking layer reads). */
function renderWire(document: AppDocument): string | undefined {
  if (document.tree?.formatVersion !== VENDO_TREE_FORMAT) return undefined;
  try {
    return printWire(
      { tree: document.tree as unknown as Tree, components: document.components ?? {}, name: document.name },
      { includeIds: true },
    );
  } catch {
    return undefined;
  }
}

/**
 * A self-explanatory failure string. A validation VendoError's message is the
 * generic "model could not produce a valid app" — the reason lives in its
 * `detail`, a string[] of validation issues. Duck-typed rather than
 * `instanceof`: the engine's @vendoai/core instance need not be ours.
 */
export function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const detail = (error as { detail?: unknown } | null)?.detail;
  const issues = Array.isArray(detail) ? detail.filter((issue): issue is string => typeof issue === "string") : [];
  return issues.length === 0 ? message : `${message}: ${issues.join(" | ")}`;
}

export function createVendoAdapter(overrides: VendoAdapterOverrides = {}): LaneAdapter {
  return {
    name: "vendo",
    async generate(prompt: string, host: HostFixture, options: LaneRunOptions = {}): Promise<LaneResult> {
      const startedAt = Date.now();
      const failed = (error: string): LaneResult => ({
        status: "failed",
        startedAt,
        durationMs: Date.now() - startedAt,
        error,
      });
      try {
        const conduct = overrides.conduct ?? conductCreate;
        const model = modelFor(options.model, overrides);
        const deps: GenerationDependencies = {
          model,
          catalog: host.catalog as NormalizedCatalog,
          tools: host.tools as HostToolInfo[],
          toolShapes: host.shapes as Readonly<Record<string, ShapeType>>,
          theme: host.theme,
          // production defaults — deliberately no `pipeline` key
        };
        const conducted = await conduct({ prompt }, deps);
        // A refusal is an ANSWER, not a crash: the host cannot do the ask, and
        // the reasons are the sentences a person would read.
        if (conducted.kind === "cannot") {
          return failed(`the host refused this ask: ${conducted.reasons.join(" | ")}`);
        }
        if (conducted.kind === "failure") {
          return failed(`generation failed: ${conducted.issues.join(" | ")}`);
        }
        const document: AppDocument = { ...conducted.document, id: `app_bench_${startedAt.toString(36)}` };
        const wire = renderWire(document);
        return {
          status: "ok",
          startedAt,
          durationMs: Date.now() - startedAt,
          document,
          ...(wire === undefined ? {} : { wire }),
          findings: conducted.findings,
        };
      } catch (error) {
        return failed(failureReason(error));
      }
    },
  };
}

export const adapter: LaneAdapter = createVendoAdapter();
export default adapter;
