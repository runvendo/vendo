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
 * `devModel()` — the env-resolving model createVendo composes when the host
 * passes none (install-dx v1: `model` is optional; real keys only). It IS an
 * ai-SDK LanguageModel (BYO seam unchanged, 03-agent §1), resolving the
 * credential lazily on first use:
 *
 * - env-key rungs delegate to the host-installed @ai-sdk provider (^3, spec
 *   v3) with full native tool calling — works in production too.
 * - VENDO_API_KEY delegates to the Vendo Cloud model gateway: the
 *   host-installed @ai-sdk/anthropic pointed at `<console>/api/v1`, whose
 *   Anthropic-compatible /messages endpoint serves the metered dev-mode
 *   allowance.
 * - nothing available → every call fails with the exact instructions.
 */

export interface DevModelOptions {
  /** Host app root; providers resolve from here. Default cwd. */
  root?: string;
  env?: Record<string, string | undefined>;
  /** Test seam for host-module resolution (providers). */
  importModule?: (root: string, specifier: string) => Promise<Record<string, unknown>>;
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
  | { mode: "delegate"; credential: DevCredential; model: LanguageModelV3Like }
  | { mode: "unavailable"; credential: DevCredential; message: string };

const DEFAULT_MODELS: Record<string, { module: string; factory: string; model: string; modelEnv: string; install: string }> = {
  anthropic: {
    module: "@ai-sdk/anthropic",
    factory: "createAnthropic",
    model: "claude-sonnet-4-6",
    modelEnv: "VENDO_DEV_ANTHROPIC_MODEL",
    install: "npm install ai@^6 @ai-sdk/anthropic@^3",
  },
  openai: {
    module: "@ai-sdk/openai",
    factory: "createOpenAI",
    model: "gpt-5",
    modelEnv: "VENDO_DEV_OPENAI_MODEL",
    install: "npm install ai@^6 @ai-sdk/openai@^3",
  },
  google: {
    module: "@ai-sdk/google",
    factory: "createGoogleGenerativeAI",
    model: "gemini-2.5-flash",
    modelEnv: "VENDO_DEV_GOOGLE_MODEL",
    install: "npm install ai@^6 @ai-sdk/google@^3",
  },
};

export const NO_CREDENTIAL_MESSAGE =
  "Vendo found no model key. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY "
  + "in .env.local (with the matching @ai-sdk provider installed), or run `vendo cloud login` for a "
  + "free dev key. Production always needs a real server-side key.";

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
  private resolution: Promise<Resolution> | null = null;
  private announced = false;

  constructor(options: DevModelOptions = {}) {
    this.root = options.root ?? process.cwd();
    this.env = options.env ?? process.env;
    this.importModule = options.importModule ?? importHostModule;
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

  private announce(credential: DevCredential, suffix = ""): void {
    if (this.announced) return;
    this.announced = true;
    console.log(`[vendo] model: ${describeDevCredential(credential)}${suffix}`);
  }

  private async resolveOnce(): Promise<Resolution> {
    const options: ResolveDevCredentialOptions = { env: this.env };
    const credential = await resolveDevCredential(options);

    if (credential.rung === "env-key") {
      const spec = DEFAULT_MODELS[credential.provider]!;
      let loaded: Record<string, unknown>;
      try {
        loaded = await this.importModule(this.root, spec.module);
      } catch {
        const message = `${credential.envVar} is set but ${spec.module} is not installed in this app; install it (\`${spec.install}\`).`;
        this.announce(credential, ` — but ${spec.module} is missing`);
        return { mode: "unavailable", credential, message };
      }
      const factory = loaded[spec.factory] as (config: { apiKey: string }) => (model: string) => LanguageModelV3Like;
      const modelId = this.env[spec.modelEnv] ?? spec.model;
      const model = factory({ apiKey: this.env[credential.envVar]! })(modelId);
      this.announce(credential, ` → ${modelId}`);
      return { mode: "delegate", credential, model };
    }

    if (credential.rung === "vendo-cloud") {
      // The gateway speaks the Anthropic Messages wire, so the anthropic
      // provider serves it — pointed at the console instead of Anthropic.
      const spec = DEFAULT_MODELS["anthropic"]!;
      let loaded: Record<string, unknown>;
      try {
        loaded = await this.importModule(this.root, spec.module);
      } catch {
        const message = `VENDO_API_KEY is set but ${spec.module} is not installed in this app; install it (\`${spec.install}\`).`;
        this.announce(credential, ` — but ${spec.module} is missing`);
        return { mode: "unavailable", credential, message };
      }
      const factory = loaded[spec.factory] as (
        config: { apiKey: string; baseURL: string },
      ) => (model: string) => LanguageModelV3Like;
      const base = resolveCloudBaseUrl({ env: this.env });
      const baseURL = base.endsWith("/api/v1") ? base : `${base}/api/v1`;
      const modelId = this.env[spec.modelEnv] ?? spec.model;
      const model = factory({ apiKey: this.env["VENDO_API_KEY"]!, baseURL })(modelId);
      this.announce(credential, ` → ${modelId} via the Cloud gateway`);
      return { mode: "delegate", credential, model };
    }

    this.announce(credential);
    return { mode: "unavailable", credential, message: NO_CREDENTIAL_MESSAGE };
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

/** The env-resolving model (see module doc). */
export function devModel(options: DevModelOptions = {}): LanguageModel {
  const controller = new DevModelController(options);
  const model: LanguageModelV3Like = {
    specificationVersion: "v3",
    provider: "vendo-dev",
    modelId: "dev-env",
    supportedUrls: {},
    doGenerate: (callOptions) => controller.doGenerate(callOptions),
    doStream: (callOptions) => controller.doStream(callOptions),
  };
  return model as unknown as LanguageModel;
}
