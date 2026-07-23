import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LanguageModel } from "ai";
import { resolveCloudBaseUrl } from "../cli/cloud/client.js";
import {
  describeDevCredential,
  resolveDevCredential,
  type DevCredential,
  type ResolveDevCredentialOptions,
} from "./resolve.js";

/**
 * `vendoModel(name?)` — the vendo model family entry (models spec 2026-07-22):
 * a lazily-resolving ai-SDK LanguageModel bound to the app's credential
 * ladder. It IS an ai-SDK LanguageModel (BYO seam unchanged, 03-agent §1),
 * resolving the credential lazily on first use:
 *
 * - env-key rungs delegate to the host-installed @ai-sdk provider (^3, spec
 *   v3) with full native tool calling — works in production too.
 * - VENDO_API_KEY delegates to the Vendo Cloud model gateway: the
 *   host-installed @ai-sdk/anthropic pointed at `<console>/api/v1`, whose
 *   Anthropic-compatible /messages endpoint serves the metered allowance
 *   under the vendo model family names (`vendo` by default).
 * - nothing available → every call fails with the exact instructions.
 *
 * Name strings pass through VERBATIM to whatever the resolved credential
 * talks to — Cloud key → the gateway (vendo-* names are real model ids
 * there), provider key → that provider, untouched. There is NO client-side
 * name translation of any kind; an unknown name surfaces the provider's own
 * error. The only "magic" is per-rung/per-slot DEFAULTS when no name is
 * given, and per-slot env pins (precedence: explicit model object → env pin
 * → configured string → per-rung default).
 *
 * `devModel()` is the deprecated pre-family alias of `vendoModel()`.
 */

/** The model slots the runtime composes. `extract` never runs in-process —
 *  it exists so the CLI extraction ladder shares the same pin names. */
export type VendoModelSlot = "agent" | "paint" | "judge" | "extract";

export interface DevModelOptions {
  /** Host app root; providers resolve from here. Default cwd. */
  root?: string;
  env?: Record<string, string | undefined>;
  /** Test seam for host-module resolution (providers). */
  importModule?: (root: string, specifier: string) => Promise<Record<string, unknown>>;
}

export interface VendoModelOptions extends DevModelOptions {
  /** Which slot's env pin + per-rung default applies. Normally inferred from
   *  the family name (`vendo-paint` → paint, `vendo-judge` → judge,
   *  `vendo-extract` → extract, anything else → agent); createVendo passes it
   *  explicitly when composing internal slots. */
  slot?: VendoModelSlot;
}

interface LanguageModelV3Like {
  specificationVersion: "v3";
  provider: string;
  modelId: string;
  supportedUrls: Record<string, RegExp[]>;
  doGenerate(options: unknown): PromiseLike<unknown>;
  doStream(options: unknown): PromiseLike<unknown>;
}

type Resolution =
  | { mode: "delegate"; model: LanguageModelV3Like }
  | { mode: "unavailable"; message: string };

interface ProviderSpec {
  module: string;
  factory: string;
  /** Flagship default (agent/extract slots) when no name is given. */
  model: string;
  /** Family fast pick (paint/judge slots) when no name is given. */
  fast: string;
  /** DEPRECATED agent-slot pin, kept working as a fallback under VENDO_MODEL. */
  modelEnv: string;
  install: string;
}

const DEFAULT_MODELS: Record<string, ProviderSpec> = {
  anthropic: {
    module: "@ai-sdk/anthropic",
    factory: "createAnthropic",
    model: "claude-sonnet-4-6",
    fast: "claude-haiku-4-5",
    modelEnv: "VENDO_DEV_ANTHROPIC_MODEL",
    install: "npm install ai@^6 @ai-sdk/anthropic@^3",
  },
  openai: {
    module: "@ai-sdk/openai",
    factory: "createOpenAI",
    model: "gpt-5",
    fast: "gpt-5-mini",
    modelEnv: "VENDO_DEV_OPENAI_MODEL",
    install: "npm install ai@^6 @ai-sdk/openai@^3",
  },
  google: {
    module: "@ai-sdk/google",
    factory: "createGoogleGenerativeAI",
    model: "gemini-2.5-flash",
    fast: "gemini-2.5-flash-lite",
    modelEnv: "VENDO_DEV_GOOGLE_MODEL",
    install: "npm install ai@^6 @ai-sdk/google@^3",
  },
};

/** The Cloud gateway serves the vendo model family as literal model ids:
 *  `vendo` (the agent), `vendo-paint`, `vendo-judge`, `vendo-extract`. The
 *  console maps each name to a concrete model SERVER-SIDE — clients never see
 *  or perform the mapping, so Cloud-keyed apps can be retuned without a
 *  client release. VENDO_CLOUD_MODEL is the deprecated agent-slot pin (the
 *  gateway grace-remaps unknown ids with an `x-vendo-model-remapped` warning
 *  header during the alias transition). Same module/factory/install as
 *  anthropic — the gateway speaks the Anthropic Messages wire. */
const CLOUD_MODEL: ProviderSpec = {
  module: "@ai-sdk/anthropic",
  factory: "createAnthropic",
  model: "vendo",
  fast: "vendo",
  modelEnv: "VENDO_CLOUD_MODEL",
  install: "npm install ai@^6 @ai-sdk/anthropic@^3",
};

/** Cloud rung slot defaults — the family names, per slot. */
const CLOUD_FAMILY: Record<VendoModelSlot, string> = {
  agent: "vendo",
  paint: "vendo-paint",
  judge: "vendo-judge",
  extract: "vendo-extract",
};

/** Env pins, one per slot (spec DX surface 5). Highest non-explicit
 *  precedence: explicit model object → env pin → models string → default. */
export const SLOT_PIN_ENV: Record<VendoModelSlot, string> = {
  agent: "VENDO_MODEL",
  paint: "VENDO_MODEL_PAINT",
  judge: "VENDO_MODEL_JUDGE",
  extract: "VENDO_MODEL_EXTRACT",
};

export const NO_CREDENTIAL_MESSAGE =
  "Vendo found no model key. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY "
  + "in .env.local (with the matching @ai-sdk provider installed), or run `vendo login` for a "
  + "free dev key. Production always needs a real server-side key.";

function nonBlank(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Family names tag their slot so per-slot env pins and the models-block
 *  config reach host-constructed instances (vendoAutoJudge(vendoModel(
 *  "vendo-judge")) is pinnable via VENDO_MODEL_JUDGE). This is slot TAGGING,
 *  never name mapping — the name itself still passes through verbatim. */
function inferSlot(name: string | undefined): VendoModelSlot {
  if (name === "vendo-paint") return "paint";
  if (name === "vendo-judge") return "judge";
  if (name === "vendo-extract") return "extract";
  return "agent";
}

/** Process-level slot config fed by createVendo({ models }) — the v1 judge
 *  plumbing (spec: models.judge is consumed only when the host wired a judge
 *  whose model came from a string, i.e. vendoModel("vendo-judge")). The judge
 *  model lives inside the host's Judge closure where composition cannot reach
 *  it, so the string travels through this module-level slot instead; the
 *  last createVendo in the process wins (multiple createVendo instances with
 *  different models.judge are out of scope for v1). @internal */
const configuredSlotModels: { judge?: string | LanguageModel } = {};

/** @internal — called by createVendo; not public API. */
export function configureVendoModelSlots(models: { judge?: string | LanguageModel } | undefined): void {
  if (models?.judge === undefined) delete configuredSlotModels.judge;
  else configuredSlotModels.judge = models.judge;
}

/** Bundler-proof dynamic import: this module runs inside the host's dev server
 *  bundle (Next/webpack/turbopack), where a computed `import(...)` becomes a
 *  runtime stub throwing "expression is too dynamic". Native import first
 *  (plain Node, test VMs), Function-constructed import as the bundler-blind
 *  fallback. The Function body is a FIXED literal — the specifier is a
 *  parameter, never interpolated into code. */
async function dynamicImport(url: string): Promise<Record<string, unknown>> {
  try {
    return await import(url) as Record<string, unknown>;
  } catch (nativeError) {
    try {
      const escaped = new Function("specifier", "return import(specifier)") as (
        specifier: string,
      ) => Promise<Record<string, unknown>>;
      return await escaped(url);
    } catch {
      throw nativeError;
    }
  }
}

async function importHostModule(root: string, specifier: string): Promise<Record<string, unknown>> {
  const require = createRequire(join(root, "package.json"));
  return await dynamicImport(pathToFileURL(require.resolve(specifier)).href);
}

export class DevModelController {
  private readonly root: string;
  private readonly env: Record<string, string | undefined>;
  private readonly importModule: (root: string, specifier: string) => Promise<Record<string, unknown>>;
  private readonly slot: VendoModelSlot;
  private readonly name: string | undefined;
  private resolution: Promise<Resolution> | null = null;
  private announced = false;

  constructor(options: VendoModelOptions & { name?: string } = {}) {
    this.root = options.root ?? process.cwd();
    this.env = options.env ?? process.env;
    this.importModule = options.importModule ?? importHostModule;
    this.name = nonBlank(options.name);
    this.slot = options.slot ?? inferSlot(this.name);
  }

  /** Resolve the credential once per process; state it on the server log once.
   *  An unavailable resolution logs its full instructions HERE — the wire
   *  deliberately shows clients only a generic error, so the operator's
   *  terminal is where the honest message must land. */
  resolve(): Promise<Resolution> {
    this.resolution ??= this.resolveOnce().then((resolution) => {
      if (resolution.mode === "unavailable") console.error(`[vendo] ${resolution.message}`);
      return resolution;
    });
    return this.resolution;
  }

  private announce(line: string): void {
    if (this.announced) return;
    this.announced = true;
    const slot = this.slot === "agent" ? "" : ` (${this.slot})`;
    console.log(`[vendo] model${slot}: ${line}`);
  }

  /** The string-tier model id for the resolved rung. Precedence (spec §DX
   *  surfaces): env pin → deprecated agent-slot pin → configured slot string
   *  (models.judge) → the verbatim name → the per-rung slot default. */
  private modelId(spec: ProviderSpec): string {
    const pin = nonBlank(this.env[SLOT_PIN_ENV[this.slot]]);
    if (pin !== undefined) return pin;
    if (this.slot === "agent") {
      const legacy = nonBlank(this.env[spec.modelEnv]);
      if (legacy !== undefined) return legacy;
    }
    if (this.slot === "judge") {
      const configured = configuredSlotModels.judge;
      if (typeof configured === "string" && nonBlank(configured) !== undefined) return configured.trim();
    }
    if (this.name !== undefined) return this.name;
    if (spec === CLOUD_MODEL) return CLOUD_FAMILY[this.slot];
    return this.slot === "paint" || this.slot === "judge" ? spec.fast : spec.model;
  }

  /** The shared delegate rung: load the provider module (an install failure
   *  resolves unavailable with the exact install command), pick the model id
   *  (per-slot precedence above), and hand the factory-built model back. */
  private async delegate(
    credential: DevCredential,
    spec: ProviderSpec,
    keyName: string,
    config: { apiKey: string; baseURL?: string },
    announceSuffix: string,
  ): Promise<Resolution> {
    let loaded: Record<string, unknown>;
    try {
      loaded = await this.importModule(this.root, spec.module);
    } catch {
      const message = `${keyName} is set but ${spec.module} is not installed in this app; install it (\`${spec.install}\`).`;
      this.announce(`${describeDevCredential(credential)} — but ${spec.module} is missing`);
      return { mode: "unavailable", message };
    }
    const factory = loaded[spec.factory] as (
      config: { apiKey: string; baseURL?: string },
    ) => (model: string) => LanguageModelV3Like;
    const modelId = this.modelId(spec);
    const model = factory(config)(modelId);
    this.announce(`${describeDevCredential(credential)} → ${modelId}${announceSuffix}`);
    return { mode: "delegate", model };
  }

  private async resolveOnce(): Promise<Resolution> {
    // Explicit model object configured for this slot (models.judge) — the
    // "explicit object wins" tier: no credential resolution, no pins.
    if (this.slot === "judge") {
      const configured = configuredSlotModels.judge;
      if (configured !== undefined && typeof configured !== "string") {
        this.announce("explicit models.judge model object");
        return { mode: "delegate", model: configured as unknown as LanguageModelV3Like };
      }
    }

    const options: ResolveDevCredentialOptions = { env: this.env };
    const credential = await resolveDevCredential(options);

    if (credential.rung === "env-key") {
      return this.delegate(
        credential,
        DEFAULT_MODELS[credential.provider]!,
        credential.envVar,
        { apiKey: this.env[credential.envVar]! },
        "",
      );
    }

    if (credential.rung === "vendo-cloud") {
      // The gateway speaks the Anthropic Messages wire, so the anthropic
      // provider serves it — pointed at the console instead of Anthropic.
      const base = resolveCloudBaseUrl({ env: this.env });
      const baseURL = base.endsWith("/api/v1") ? base : `${base}/api/v1`;
      return this.delegate(
        credential,
        CLOUD_MODEL,
        "VENDO_API_KEY",
        { apiKey: this.env["VENDO_API_KEY"]!, baseURL },
        " via the Cloud gateway",
      );
    }

    this.announce(describeDevCredential(credential));
    return { mode: "unavailable", message: NO_CREDENTIAL_MESSAGE };
  }

  async doGenerate(callOptions: unknown): Promise<unknown> {
    const resolution = await this.resolve();
    if (resolution.mode === "delegate") return resolution.model.doGenerate(callOptions);
    throw new Error(resolution.message);
  }

  async doStream(callOptions: unknown): Promise<unknown> {
    const resolution = await this.resolve();
    if (resolution.mode === "delegate") return resolution.model.doStream(callOptions);
    throw new Error(resolution.message);
  }
}

function lazyModel(controller: DevModelController, provider: string, modelId: string): LanguageModel {
  const model: LanguageModelV3Like = {
    specificationVersion: "v3",
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: (callOptions) => controller.doGenerate(callOptions),
    doStream: (callOptions) => controller.doStream(callOptions),
  };
  return model as unknown as LanguageModel;
}

/** The vendo model family entry (see module doc). No argument means the
 *  agent slot: `vendo` on the Cloud rung, the provider's flagship default on
 *  a BYO rung. A name is passed VERBATIM to the resolved rung. */
export function vendoModel(name?: string, options: VendoModelOptions = {}): LanguageModel {
  const controller = new DevModelController({ ...options, ...(name === undefined ? {} : { name }) });
  return lazyModel(controller, "vendo", name ?? "vendo-env");
}

/** @deprecated Renamed `vendoModel()` (models spec 2026-07-22) — same ladder,
 *  same behavior; this alias remains for one release. */
export function devModel(options: DevModelOptions = {}): LanguageModel {
  return lazyModel(new DevModelController(options), "vendo-dev", "dev-env");
}
