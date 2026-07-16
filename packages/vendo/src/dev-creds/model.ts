import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ClaudeSessionRider,
  CodexSessionRider,
  claudeGenerate,
  codexGenerate,
  type RiderSession,
} from "@vendoai/dev-riders";
import type { LanguageModel } from "ai";
import {
  describeDevCredential,
  hasSessionConsent,
  resolveDevCredential,
  type DevCredential,
  type ResolveDevCredentialOptions,
} from "./resolve.js";

/**
 * ENG-338 — `devModel()`: the ladder-backed model `vendo init` scaffolds into
 * a fresh app. It IS an ai-SDK LanguageModel (BYO seam unchanged, 03-agent §1),
 * resolving the dev-mode credential ladder lazily on first use:
 *
 * - env-key rungs delegate to the host-installed @ai-sdk provider (^3, spec v3)
 *   with full native tool calling — works in production too.
 * - session rungs answer tool-less generation (apps, refine, doctor) through a
 *   one-shot rider, while the CHAT loop runs the full-tool rider seam that
 *   createVendo wires from the marker this model carries (dev only, consent
 *   required, refused outright in production).
 * - nothing available → every call fails with the exact instructions
 *   (today's honest-failure behavior, now with the ladder spelled out).
 */

/** Cross-module marker (Symbol.for: host app and umbrella may load separate
 *  copies of this module). */
export const DEV_MODEL_MARKER = Symbol.for("vendo.devModel@1");

export interface DevModelOptions {
  /** Host app root; providers and the Agent SDK resolve from here. Default cwd. */
  root?: string;
  env?: Record<string, string | undefined>;
  /** Test seams for the CLI-session probes. */
  probes?: ResolveDevCredentialOptions["probes"];
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
  | { mode: "rider"; credential: { rung: "claude-session" | "codex-session" } }
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
  "Vendo found no model credential. Dev-mode ladder: set ANTHROPIC_API_KEY / OPENAI_API_KEY / "
  + "GOOGLE_GENERATIVE_AI_API_KEY in .env.local, or log in to the Claude Code or Codex CLI and re-run "
  + "`vendo init` to consent to riding that session (dev only). Production always needs a real key.";

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

/** Flatten a LanguageModelV3 prompt into (system, text) for a tool-less rider
 *  generation — session rungs serve generation-shaped calls only; the chat
 *  loop rides the full-tool session seam instead. */
export function flattenPrompt(prompt: unknown): { system: string; text: string } {
  const systems: string[] = [];
  const turns: string[] = [];
  if (Array.isArray(prompt)) {
    for (const message of prompt as Array<{ role?: string; content?: unknown }>) {
      if (message.role === "system" && typeof message.content === "string") {
        systems.push(message.content);
        continue;
      }
      if (!Array.isArray(message.content)) continue;
      const text = (message.content as Array<{ type?: string; text?: string }>)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      if (text.length === 0) continue;
      if (message.role === "user") turns.push(text);
      else if (message.role === "assistant") turns.push(`[assistant] ${text}`);
    }
  }
  return {
    system: systems.join("\n\n"),
    text: turns.length > 0 ? turns.join("\n\n") : " ",
  };
}

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

export class DevModelController {
  private readonly root: string;
  private readonly env: Record<string, string | undefined>;
  private readonly probes: ResolveDevCredentialOptions["probes"];
  private readonly importModule: (root: string, specifier: string) => Promise<Record<string, unknown>>;
  private resolution: Promise<Resolution> | null = null;
  private readonly chatSessions = new Map<string, RiderSession>();
  private warmSession: WarmClaudeSession | null = null;
  private announced = false;

  constructor(options: DevModelOptions = {}) {
    this.root = options.root ?? process.cwd();
    this.env = options.env ?? process.env;
    this.probes = options.probes;
    this.importModule = options.importModule ?? importHostModule;
  }

  /** Resolve the ladder once per process; state it on the server log once.
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
    console.log(`[vendo] dev-mode model: ${describeDevCredential(credential)}${suffix}`);
  }

  private async resolveOnce(): Promise<Resolution> {
    const credential = await resolveDevCredential({
      env: this.env,
      ...(this.probes === undefined ? {} : { probes: this.probes }),
    });

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

    if (credential.rung === "claude-session" || credential.rung === "codex-session") {
      if (!(await hasSessionConsent(this.root, credential.rung, this.env))) {
        const message = `Found ${describeDevCredential(credential)} but no recorded consent to use it. `
          + "Re-run `vendo init` to consent, or set VENDO_DEV_ALLOW_SESSIONS=1. Production always needs a real key.";
        this.announce(credential, " — consent not recorded, not used");
        return { mode: "unavailable", credential, message };
      }
      this.announce(credential, " — production needs a real key");
      return { mode: "rider", credential: { rung: credential.rung } };
    }

    if (credential.rung === "vendo-cloud") {
      const message = "VENDO_API_KEY is set, but Vendo Cloud dev-mode model keys are minted by `vendo cloud login` "
        + "(landing with doctor v2). Until then set a provider key, or log in to the Claude Code / Codex CLI for dev mode.";
      this.announce(credential, " — no model gateway yet");
      return { mode: "unavailable", credential, message };
    }

    this.announce(credential);
    return { mode: "unavailable", credential, message: NO_CREDENTIAL_MESSAGE };
  }

  private newRiderSession(rung: "claude-session" | "codex-session"): RiderSession {
    if (rung === "claude-session") {
      const model = this.env["VENDO_DEV_CLAUDE_MODEL"];
      return new ClaudeSessionRider({ root: this.root, ...(model === undefined ? {} : { model }) });
    }
    const model = this.env["VENDO_DEV_CODEX_MODEL"];
    return new CodexSessionRider({ cwd: this.root, ...(model === undefined ? {} : { model }) });
  }

  /** The rider seam createVendo wires into the agent: one persistent session
   *  per thread on session rungs; null on key rungs (native loop). */
  async chatSession(threadId: string): Promise<RiderSession | null> {
    const resolution = await this.resolve();
    if (resolution.mode !== "rider") return null;
    let session = this.chatSessions.get(threadId);
    if (session === undefined) {
      if (this.warmSession !== null) {
        // Adopt the boot-warmed session for the first thread (spike gotcha:
        // the Claude rider's spawn+init costs ~12s — pay it at dev-server
        // boot, not on the user's first message).
        session = this.warmSession;
        this.warmSession = null;
      } else {
        session = this.newRiderSession(resolution.credential.rung);
      }
      this.chatSessions.set(threadId, session);
    }
    return session;
  }

  /** Fire-and-forget boot warmup (createVendo calls this in development):
   *  pre-spawns the first Claude session with the real tool surface and a
   *  representative system prompt, then swaps in the real bridge on adoption. */
  warmup(input: { system: string; tools: Array<{ name: string; description: string; inputSchema: unknown }> }): void {
    void (async () => {
      let session: WarmClaudeSession | null = null;
      try {
        const resolution = await this.resolve();
        if (resolution.mode !== "rider" || resolution.credential.rung !== "claude-session") return;
        if (this.warmSession !== null || this.chatSessions.size > 0) return;
        session = new WarmClaudeSession(this.newRiderSession("claude-session") as ClaudeSessionRider);
        this.warmSession = session;
        await session.prewarm(input);
      } catch {
        // Cold start on the first message instead; never leave a broken
        // warm session (or its subprocess) behind.
        if (session !== null && this.warmSession === session) {
          this.warmSession = null;
          await session.dispose().catch(() => undefined);
        }
      }
    })();
  }

  /** One tool-less generation turn through the resolved session rung. */
  async riderGenerate(input: { system: string; text: string; onTextDelta?: (delta: string) => void }): Promise<string> {
    const resolution = await this.resolve();
    if (resolution.mode === "unavailable") throw new Error(resolution.message);
    if (resolution.mode === "delegate") throw new Error("riderGenerate is session-rung only");
    const options = { system: input.system, prompt: input.text, ...(input.onTextDelta === undefined ? {} : { onTextDelta: input.onTextDelta }) };
    if (resolution.credential.rung === "claude-session") {
      const model = this.env["VENDO_DEV_CLAUDE_MODEL"];
      return claudeGenerate(options, { root: this.root, ...(model === undefined ? {} : { model }) });
    }
    const model = this.env["VENDO_DEV_CODEX_MODEL"];
    return codexGenerate(options, { cwd: this.root, ...(model === undefined ? {} : { model }) });
  }

  async doGenerate(callOptions: unknown): Promise<unknown> {
    const resolution = await this.resolve();
    if (resolution.mode === "delegate") return resolution.model.doGenerate(callOptions);
    if (resolution.mode === "unavailable") throw new Error(resolution.message);
    const { system, text } = flattenPrompt((callOptions as { prompt?: unknown }).prompt);
    const answer = await this.riderGenerate({ system, text });
    return {
      content: [{ type: "text", text: answer }],
      finishReason: { unified: "stop", raw: undefined },
      usage: ZERO_USAGE,
      warnings: [],
    };
  }

  async doStream(callOptions: unknown): Promise<unknown> {
    const resolution = await this.resolve();
    if (resolution.mode === "delegate") return resolution.model.doStream(callOptions);
    if (resolution.mode === "unavailable") throw new Error(resolution.message);
    const { system, text } = flattenPrompt((callOptions as { prompt?: unknown }).prompt);
    const generate = (input: { system: string; text: string; onTextDelta?: (delta: string) => void }) =>
      this.riderGenerate(input);
    const stream = new ReadableStream({
      async start(controller) {
        const id = "text_1";
        controller.enqueue({ type: "text-start", id });
        try {
          await generate({ system, text, onTextDelta: (delta) => controller.enqueue({ type: "text-delta", id, delta }) });
          controller.enqueue({ type: "text-end", id });
          controller.enqueue({ type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } });
          controller.close();
        } catch (error) {
          controller.enqueue({ type: "error", error });
          controller.close();
        }
      },
    });
    return { stream };
  }
}

/** A Claude session that can spawn (and warm) before the bridge attaches: the
 *  bridge's later start() swaps the live tool executor in — no second spawn. */
class WarmClaudeSession implements RiderSession {
  private readonly inner: ClaudeSessionRider;
  private prewarmPromise: Promise<void> | null = null;
  private onToolCall: ((call: { tool: string; args: unknown }) => Promise<{ text: string; ok: boolean }>) | null = null;

  constructor(inner: ClaudeSessionRider) {
    this.inner = inner;
  }

  prewarm(input: { system: string; tools: Array<{ name: string; description: string; inputSchema: unknown }> }): Promise<void> {
    this.prewarmPromise = (async () => {
      await this.inner.start({
        system: input.system,
        tools: input.tools,
        onToolCall: async (call) => {
          const handler = this.onToolCall;
          if (handler === null) return { text: "Tool bridge not attached yet.", ok: false };
          return handler(call);
        },
      });
      // Force process spawn + session init now (streaming-input emits nothing
      // until the first message); the warmup reply is discarded.
      await this.inner.runTurn("Reply with exactly: ok", () => {});
    })();
    return this.prewarmPromise;
  }

  /** Adoption may land MID-warmup: never double-start — wait for the warm
   *  session and just swap the live tool bridge in. A failed warmup degrades
   *  to a cold start. */
  async start(options: Parameters<RiderSession["start"]>[0]): Promise<void> {
    this.onToolCall = options.onToolCall;
    if (this.prewarmPromise !== null) {
      try {
        await this.prewarmPromise;
        return;
      } catch {
        this.prewarmPromise = null;
      }
    }
    await this.inner.start({ ...options, onToolCall: (call) => this.onToolCall!(call) });
  }

  runTurn(text: string, onTextDelta: (delta: string) => void): Promise<{ text: string }> {
    return this.inner.runTurn(text, onTextDelta);
  }

  dispose(): Promise<void> {
    return this.inner.dispose();
  }
}

/** The scaffolded dev model (see module doc). */
export function devModel(options: DevModelOptions = {}): LanguageModel {
  const controller = new DevModelController(options);
  const model: LanguageModelV3Like & { [DEV_MODEL_MARKER]?: DevModelController } = {
    specificationVersion: "v3",
    provider: "vendo-dev",
    modelId: "dev-ladder",
    supportedUrls: {},
    doGenerate: (callOptions) => controller.doGenerate(callOptions),
    doStream: (callOptions) => controller.doStream(callOptions),
  };
  Object.defineProperty(model, DEV_MODEL_MARKER, { value: controller, enumerable: false });
  return model as unknown as LanguageModel;
}

/** createVendo's marker probe: the controller when `model` came from devModel().
 *  Structural check beside instanceof: the host app and the umbrella can load
 *  separate copies of this module (Symbol.for keeps the marker shared). */
export function devModelController(model: unknown): DevModelController | null {
  if (typeof model !== "object" || model === null) return null;
  const controller = (model as Record<symbol, unknown>)[DEV_MODEL_MARKER];
  if (controller instanceof DevModelController) return controller;
  if (typeof (controller as { chatSession?: unknown } | undefined)?.chatSession === "function") {
    return controller as DevModelController;
  }
  return null;
}
