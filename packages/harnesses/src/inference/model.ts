import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acceptsSamplingParams, UNKNOWN_MODEL_MAX_OUTPUT_TOKENS } from "@vendoai/apps";
import { log, meterExhaustedFromError, VendoError } from "@vendoai/core";
import type { LanguageModel } from "ai";
import {
  describeDevCredential,
  resolveDevCredential,
  type DevCredential,
  type EnvKeyProvider,
  type ResolveDevCredentialOptions,
} from "./resolve.js";

/**
 * `vendoModel(name?)` — the vendo model family entry (models spec 2026-07-22):
 * a lazily-resolving ai-SDK LanguageModel bound to the app's credential
 * ladder. It IS an ai-SDK LanguageModel (BYO seam unchanged, 03-agent §1),
 * resolving the credential lazily on first use:
 *
 * - env-key rungs delegate to the host-installed @ai-sdk provider (^3, spec
 *   v3) with full native tool calling — works in production too. Since the
 *   selection law they are reachable only through the internal
 *   VENDO_DEV_CREDENTIAL pin: a host's own provider key belongs in `models`,
 *   where it is a CHOICE (`models: { default: anthropic(key) }`), not in an env
 *   var Vendo sniffs.
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
 */

/** The model slots the runtime composes — one per real job, matching the seats
 *  in `@vendoai/core` (`agent` is what the `default` seat rides). `extract`
 *  never runs in-process; it exists so the CLI extraction ladder shares the
 *  same pin names. */
export type VendoModelSlot = "agent" | "apps" | "review" | "judge" | "extract";

export interface VendoModelOptions {
  /** Host app root; providers resolve from here. Default cwd. */
  root?: string;
  env?: Record<string, string | undefined>;
  /** Test seam for host-module resolution (providers). */
  importModule?: (root: string, specifier: string) => Promise<Record<string, unknown>>;
  /** Which slot's env pin + per-rung default applies. Normally inferred from
   *  the family name (`vendo-apps` → apps, `vendo-review` → review,
   *  `vendo-judge` → judge, `vendo-extract` → extract, anything else → agent);
   *  createVendo passes it explicitly when composing internal slots. */
  slot?: VendoModelSlot;
}

interface LanguageModelV3Like {
  specificationVersion: "v3";
  provider: string;
  modelId: string;
  supportedUrls: PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>;
  doGenerate(options: unknown): PromiseLike<unknown>;
  doStream(options: unknown): PromiseLike<unknown>;
}

type Resolution =
  /** The credential rides along so a rejected key can name its own fix
   *  (rejectedKey below); an explicit host-passed model object has none. */
  | { mode: "delegate"; model: LanguageModelV3Like; credential?: DevCredential }
  | { mode: "unavailable"; message: string };

interface ProviderSpec {
  module: string;
  factory: string;
  /** Flagship default (agent/apps/extract slots) when no name is given. */
  model: string;
  /** Family fast pick (review/judge slots) when no name is given. */
  fast: string;
  install: string;
}

const DEFAULT_MODELS: Record<string, ProviderSpec> = {
  anthropic: {
    module: "@ai-sdk/anthropic",
    factory: "createAnthropic",
    model: "claude-sonnet-4-6",
    fast: "claude-haiku-4-5",
    install: "npm install ai@^6 @ai-sdk/anthropic@^3",
  },
  openai: {
    module: "@ai-sdk/openai",
    factory: "createOpenAI",
    model: "gpt-5",
    fast: "gpt-5-mini",
    install: "npm install ai@^6 @ai-sdk/openai@^3",
  },
  google: {
    module: "@ai-sdk/google",
    factory: "createGoogleGenerativeAI",
    model: "gemini-2.5-flash",
    fast: "gemini-2.5-flash-lite",
    install: "npm install ai@^6 @ai-sdk/google@^3",
  },
};

/** The Cloud gateway serves the vendo model family as literal model ids:
 *  `vendo` (the agent), `vendo-apps`, `vendo-review`, `vendo-judge`,
 *  `vendo-extract`. The console maps each name to a concrete model
 *  SERVER-SIDE — clients never see
 *  or perform the mapping, so Cloud-keyed apps can be retuned without a
 *  client release. Same module/factory/install as anthropic — the gateway
 *  speaks the Anthropic Messages wire. */
const CLOUD_MODEL: ProviderSpec = {
  module: "@ai-sdk/anthropic",
  factory: "createAnthropic",
  model: "vendo",
  fast: "vendo",
  install: "npm install ai@^6 @ai-sdk/anthropic@^3",
};

/** The console the Cloud rung dials, same default and same trailing-slash
 *  trim as `resolveCloudBaseUrl` in `@vendoai/vendo` — read here rather than
 *  imported, because `@vendoai/vendo` already depends on this package and the
 *  edge back would be a cycle. */
const CONSOLE_URL = "https://console.vendo.run";

/** Cloud rung slot defaults — the family names, per slot. */
const CLOUD_FAMILY: Record<VendoModelSlot, string> = {
  agent: "vendo",
  apps: "vendo-apps",
  review: "vendo-review",
  judge: "vendo-judge",
  extract: "vendo-extract",
};

/** Env pins, one per slot (spec DX surface 5). Highest non-explicit
 *  precedence: explicit model object → env pin → models string → default. */
export const SLOT_PIN_ENV: Record<VendoModelSlot, string> = {
  agent: "VENDO_MODEL",
  apps: "VENDO_MODEL_APPS",
  review: "VENDO_MODEL_REVIEW",
  judge: "VENDO_MODEL_JUDGE",
  extract: "VENDO_MODEL_EXTRACT",
};

/** The keyless boot error. Both ways out, in order: explicit config first, then
 *  VENDO_API_KEY. Byte-for-byte coupled to `MODEL_UNAVAILABLE_SIGNAL` in
 *  `@vendoai/apps` (server/doors/build-messages.ts), which anchors on this
 *  sentence's opening so the actionable line survives the build door's fold —
 *  change one and the other stops matching. The seam is tested in
 *  tests/dev-creds/model.test.ts, through the real regex. */
export const NO_CREDENTIAL_MESSAGE =
  "Vendo has no model. Pass one — models: { default: anthropic(\"claude-sonnet-4-6\") } in "
  + "createVendo — or set VENDO_API_KEY for the Vendo Cloud gateway (`vendo login` mints a free "
  + "dev key). A provider key alone no longer selects a model; Vendo never picks a provider for you.";

function nonBlank(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Family names tag their slot so per-slot env pins and the models-block
 *  config reach host-constructed instances (vendoAutoJudge(vendoModel(
 *  "vendo-judge")) is pinnable via VENDO_MODEL_JUDGE). This is slot TAGGING,
 *  never name mapping — the name itself still passes through verbatim. */
function inferSlot(name: string | undefined): VendoModelSlot {
  if (name === "vendo-apps") return "apps";
  if (name === "vendo-review") return "review";
  if (name === "vendo-judge") return "judge";
  if (name === "vendo-extract") return "extract";
  return "agent";
}

/** The cheap/fast slots: no name given means the family's fast pick, not the
 *  flagship. Reading jobs only — grading a finished app and answering
 *  run/ask/block are both reading; writing an app is not. */
const FAST_SLOTS = new Set<VendoModelSlot>(["review", "judge"]);

/** The slots whose model `createVendo`'s `models` block can configure by name
 *  or object. Every other slot resolves through the seat record
 *  (resolveModels), so they are not bound per-instance here. */
const CONFIGURABLE_SLOTS = ["judge"] as const;
type ConfigurableSlot = (typeof CONFIGURABLE_SLOTS)[number];
export type ConfigurableSlotModels = Partial<Record<ConfigurableSlot, string | LanguageModel>>;

/** The controller behind each vendoModel() instance, so composition
 *  can bind per-instance slot config onto exactly the model the host handed it
 *  (bindVendoModelSlots below). WeakMap: holding a model never leaks its
 *  controller past the model's own lifetime. @internal */
const controllersByModel = new WeakMap<object, DevModelController>();

/** Bind createVendo's `models` slot config onto ONE vendoModel-built instance
 *  (spec: models.judge is consumed only by a judge the host wired from
 *  vendoModel("vendo-judge") — the model rides Judge.model so composition can
 *  reach it). Per instance, replacing the former process-level registry whose
 *  last createVendo won. A BYO model object (or anything else that is not a
 *  vendoModel instance) is a deliberate no-op: explicit models never change
 *  behavior. @internal — called by createVendo; not public API. */
export function bindVendoModelSlots(
  model: unknown,
  models: ConfigurableSlotModels | undefined,
): void {
  if (model === null || typeof model !== "object") return;
  controllersByModel.get(model)?.configureSlots(models);
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

/** Host-root resolution first, vendo's own copy as the provider fallback.
 *
 *  Precedence: the HOST's install always wins when present — their version,
 *  their module instance, so the `ai` SDK never sees two copies of one
 *  provider in a repo that has it (the dual-package hazard). Only when the
 *  host root resolves nothing do we resolve from vendo's own module context
 *  (createRequire off import.meta.url): @ai-sdk/anthropic ships as a real
 *  dependency of @vendoai/vendo, so a VENDO_API_KEY — via the
 *  Anthropic-compatible Cloud gateway — lights up live chat under
 *  `npx vendo try` with nothing installed in the repo. Scoped to @ai-sdk/*
 *  provider modules; arbitrary specifiers keep strict host-root resolution.
 *  (Exported for the resolution tests; the injectable seam is `importModule`.) */
export async function importHostModule(root: string, specifier: string): Promise<Record<string, unknown>> {
  const require = createRequire(join(root, "package.json"));
  try {
    return await dynamicImport(pathToFileURL(require.resolve(specifier)).href);
  } catch (hostError) {
    if (!specifier.startsWith("@ai-sdk/")) throw hostError;
    try {
      const self = createRequire(import.meta.url);
      return await dynamicImport(pathToFileURL(self.resolve(specifier)).href);
    } catch {
      // The host's failure is the honest one to surface — "not installed in
      // this app" plus the install command, same as before the fallback.
      throw hostError;
    }
  }
}

export class DevModelController {
  private readonly root: string;
  private readonly env: Record<string, string | undefined>;
  private readonly importModule: (root: string, specifier: string) => Promise<Record<string, unknown>>;
  private readonly slot: VendoModelSlot;
  private readonly name: string | undefined;
  private resolution: Promise<Resolution> | null = null;
  private announced = false;
  /** Per-instance slot config bound by createVendo (bindVendoModelSlots). */
  private slotModels: ConfigurableSlotModels = {};

  constructor(options: VendoModelOptions & { name?: string } = {}) {
    this.root = options.root ?? process.cwd();
    this.env = options.env ?? process.env;
    this.importModule = options.importModule ?? importHostModule;
    this.name = nonBlank(options.name);
    this.slot = options.slot ?? inferSlot(this.name);
  }

  /** Bind createVendo's `models` slot config to THIS instance (see
   *  bindVendoModelSlots). Composition runs before the first model call, so
   *  the lazy resolution below always sees the bound config. */
  configureSlots(models: ConfigurableSlotModels | undefined): void {
    for (const slot of CONFIGURABLE_SLOTS) {
      const configured = models?.[slot];
      if (configured === undefined) delete this.slotModels[slot];
      else this.slotModels[slot] = configured;
    }
  }

  /** What `models.<slot>` says for THIS instance's slot, if anything. */
  private get configured(): string | LanguageModel | undefined {
    return CONFIGURABLE_SLOTS.includes(this.slot as ConfigurableSlot)
      ? this.slotModels[this.slot as ConfigurableSlot]
      : undefined;
  }

  /** Resolve the credential once per process; state it on the server log once.
   *  An unavailable resolution logs its full instructions HERE — the wire
   *  deliberately shows clients only a generic error, so the operator's
   *  terminal is where the honest message must land. */
  resolve(): Promise<Resolution> {
    this.resolution ??= this.resolveOnce().then((resolution) => {
      if (resolution.mode === "unavailable") {
        log({
          code: "vendo.model-resolution-unavailable",
          level: "error",
          message: `[vendo] ${resolution.message}`,
        });
      }
      return resolution;
    });
    return this.resolution;
  }

  private announce(line: string): void {
    if (this.announced) return;
    this.announced = true;
    const slot = this.slot === "agent" ? "" : ` (${this.slot})`;
    log({
      code: "vendo.model-announce",
      level: "info",
      message: `[vendo] model${slot}: ${line}`,
    });
  }

  /** The string-tier model id for the resolved rung. Precedence (spec §DX
   *  surfaces): env pin → configured slot string (models.judge) → the verbatim
   *  name → the per-rung slot default. */
  private modelId(spec: ProviderSpec): string {
    const pin = nonBlank(this.env[SLOT_PIN_ENV[this.slot]]);
    if (pin !== undefined) return pin;
    const configured = this.configured;
    if (typeof configured === "string" && nonBlank(configured) !== undefined) return configured.trim();
    if (this.name !== undefined) return this.name;
    if (spec === CLOUD_MODEL) return CLOUD_FAMILY[this.slot];
    return FAST_SLOTS.has(this.slot) ? spec.fast : spec.model;
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
    return { mode: "delegate", model, credential };
  }

  private async resolveOnce(): Promise<Resolution> {
    // Explicit model object configured for this slot (models.judge) — the
    // "explicit object wins" tier: no credential resolution, no pins.
    const configured = this.configured;
    if (configured !== undefined && typeof configured !== "string") {
      this.announce(`explicit models.${this.slot} model object`);
      return { mode: "delegate", model: configured as unknown as LanguageModelV3Like };
    }

    const options: ResolveDevCredentialOptions = { env: this.env };
    const credential = await resolveDevCredential(options);

    // Reachable only through the internal VENDO_DEV_CREDENTIAL pin now (see
    // resolve.ts): a bare provider key in the environment selects nothing.
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
      const base = (this.env["VENDO_CLOUD_URL"] ?? CONSOLE_URL).replace(/\/+$/, "");
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

  /** This controller's own lazy model — the credential-aware call path. A
   *  caller that probes `resolve()` first (vendo try's capability flags) must
   *  hand THIS to the runtime, never the raw provider model the resolution
   *  carries: only this path keeps the rejected key's rung (rejectedKey). */
  model(): LanguageModel {
    return lazyModel(this, "vendo", this.name ?? "vendo-env");
  }

  doGenerate(callOptions: unknown): Promise<unknown> {
    return this.call(callOptions, (model, options) => model.doGenerate(options));
  }

  doStream(callOptions: unknown): Promise<unknown> {
    return this.call(callOptions, (model, options) => model.doStream(options));
  }

  private async call<T>(
    callOptions: unknown,
    invoke: (model: LanguageModelV3Like, options: unknown) => PromiseLike<T>,
  ): Promise<T> {
    const resolution = await this.resolve();
    if (resolution.mode === "unavailable") throw new VendoError("validation", resolution.message);
    try {
      return await invoke(resolution.model, resolvedCallOptions(callOptions, resolution.model));
    } catch (error) {
      const fix = rejectedKey(resolution.credential, error);
      if (fix === undefined) throw error;
      // The provider error stays the `cause`: its request id and response
      // headers are the operator's diagnostic trail, and the agent logs the
      // thrown error verbatim before the wire ever sees the crafted message.
      throw Object.assign(fix, { cause: error });
    }
  }
}

const PROVIDER_LABELS: Record<EnvKeyProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

/** The rejected-key fix, per rung. Only the ladder knows WHICH credential the
 *  provider just refused, so this is the one place the next step can be right:
 *  telling a BYO-key host to run `vendo login` (or a Cloud host to edit a
 *  provider key) sends them the wrong way. A 401 carrying the Cloud meter
 *  refusal keeps its own richer sentence (the agent's pricing rail formats that
 *  from the body); every other error travels untouched. A status duck-check is
 *  enough here — unlike the agent's wire gate, this only ever sees the model
 *  call's own failure, whichever ai-SDK copy the provider install came from. */
function rejectedKey(credential: DevCredential | undefined, error: unknown): VendoError | undefined {
  const rejected = typeof error === "object" && error !== null
    && (error as { statusCode?: unknown }).statusCode === 401
    && meterExhaustedFromError(error) === undefined;
  if (!rejected) return undefined;
  if (credential?.rung === "vendo-cloud") {
    return new VendoError(
      "cloud-required",
      "VENDO_API_KEY was rejected by the Vendo Cloud model gateway (401) — run `vendo login` to mint a fresh key "
      + "(it lands in .env.local), or manage project keys in the Vendo Cloud console.",
    );
  }
  if (credential?.rung === "env-key") {
    return new VendoError(
      "validation",
      `your ${PROVIDER_LABELS[credential.provider]} API key was rejected (401) — check ${credential.envVar} `
      + "in .env.local; a revoked or mistyped key fails exactly this way.",
    );
  }
  return undefined;
}

/** Sampling params, re-decided against the RESOLVED rung. The lazy wrapper's
 *  modelId is the family name by design (lazyModel below), so model-params'
 *  Claude 5 allowlist never sees the real id: the engine's `temperature: 0`
 *  rides through the ladder and a pinned Claude 5 rung 400s every call (#692).
 *  Call time is after resolution — the one moment the real id is known — so a
 *  rejecting rung's sampling params are dropped here and the explicit output
 *  cap is set (same rule and reasons as modelCallParams: a sampling-era
 *  provider registry silently truncates an unknown id at 4096 otherwise).
 *  Sampling-era Claude and non-Claude rungs pass through untouched. */
function resolvedCallOptions(callOptions: unknown, model: LanguageModelV3Like): unknown {
  if (acceptsSamplingParams(model.modelId)) return callOptions;
  const options = { ...(callOptions as Record<string, unknown>) };
  delete options["temperature"];
  delete options["topP"];
  delete options["topK"];
  options["maxOutputTokens"] ??= UNKNOWN_MODEL_MAX_OUTPUT_TOKENS;
  return options;
}

function lazyModel(controller: DevModelController, provider: string, modelId: string): LanguageModel {
  const model: LanguageModelV3Like = {
    specificationVersion: "v3",
    // The lazy IDENTITY is vendo's own by design (the family name is the seam).
    provider,
    modelId,
    // CAPABILITY, though, must be the resolved provider's: the SDK reads
    // supportedUrls to decide whether a remote image/PDF is ingested natively
    // or downloaded first, so answering "none" makes callers fetch files the
    // provider could have fetched itself — fatal under restricted egress. The
    // spec allows a promise here, which is what lets a lazy rung answer.
    get supportedUrls() {
      return controller.resolve().then((resolution) => (
        resolution.mode === "delegate" ? resolution.model.supportedUrls : {}
      ));
    },
    doGenerate: (callOptions) => controller.doGenerate(callOptions),
    doStream: (callOptions) => controller.doStream(callOptions),
  };
  // Registered so composition can bind per-instance slot config onto exactly
  // this model (bindVendoModelSlots).
  controllersByModel.set(model, controller);
  return model as unknown as LanguageModel;
}

/** The vendo model family entry (see module doc). No argument means the
 *  agent slot: `vendo` on the Cloud rung, the provider's flagship default on
 *  a BYO rung. A name is passed VERBATIM to the resolved rung. */
export function vendoModel(name?: string, options: VendoModelOptions = {}): LanguageModel {
  return new DevModelController({ ...options, ...(name === undefined ? {} : { name }) }).model();
}
