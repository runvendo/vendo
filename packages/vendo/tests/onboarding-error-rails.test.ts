import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VendoError } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liveModelTurn } from "../src/cli/doctor-live.js";
import { DevModelController, NO_CREDENTIAL_MESSAGE, vendoModel } from "../src/dev-creds/model.js";
import { createVendo } from "../src/server.js";

/**
 * The first-hour failures: no model key at all, and a key the gateway or
 * provider rejects. Both must reach the person running the app as the FIX,
 * not as "An error occurred while generating the response." — which is what
 * the wire's safe-error gate makes of any plain Error.
 */

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A provider module whose model fails every call with `error`. */
function failingProvider(factoryName: string, error: unknown, supportedUrls: Record<string, RegExp[]> = {}) {
  return async (): Promise<Record<string, unknown>> => ({
    [factoryName]: () => (modelId: string) => ({
      specificationVersion: "v3",
      provider: "scripted",
      modelId,
      supportedUrls,
      doGenerate: async () => { throw error; },
      doStream: async () => { throw error; },
    }),
  });
}

const unauthorized = (body: unknown = { error: { message: "invalid x-api-key" } }) =>
  Object.assign(new Error("Unauthorized"), { statusCode: 401, responseBody: JSON.stringify(body) });

/** The lazy model's own surface, behind the ai-SDK LanguageModel type. */
function lazy(model: LanguageModel): {
  supportedUrls: PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>;
  doStream(options: unknown): Promise<unknown>;
} {
  return model as unknown as ReturnType<typeof lazy>;
}

async function rejection(call: Promise<unknown>): Promise<VendoError> {
  const error = await call.then(() => undefined, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(VendoError);
  return error as VendoError;
}

/** The env-key rungs, as they are reachable AFTER the selection law: a provider
 *  key in the environment selects nothing on its own, so a case that exercises
 *  one of those rungs names it through the internal VENDO_DEV_CREDENTIAL pin.
 *  The rejected-key and missing-install rails below are unchanged; what changed
 *  is who may ask for the rung. */
const BYO = {
  anthropic: { VENDO_DEV_CREDENTIAL: "env-key:anthropic", ANTHROPIC_API_KEY: "sk-a" },
  openai: { VENDO_DEV_CREDENTIAL: "env-key:openai", OPENAI_API_KEY: "sk-o" },
} as const;

describe("the keyless model failure", () => {
  it("throws a VendoError so the safe-error gate carries the fix instead of genericizing it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new DevModelController({ env: {} });
    for (const call of [controller.doGenerate({ prompt: [] }), controller.doStream({ prompt: [] })]) {
      const error = await rejection(call);
      expect(error.code).toBe("validation");
      expect(error.message).toBe(NO_CREDENTIAL_MESSAGE);
    }
  });

  it("throws a VendoError naming the missing provider install", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new DevModelController({
      env: { ...BYO.anthropic },
      importModule: async (_root, specifier) => { throw new Error(`Cannot find module '${specifier}'`); },
    });
    const error = await rejection(controller.doGenerate({ prompt: [] }));
    expect(error.code).toBe("validation");
    expect(error.message).toBe(
      "ANTHROPIC_API_KEY is set but @ai-sdk/anthropic is not installed in this app; "
      + "install it (`npm install ai@^6 @ai-sdk/anthropic@^3`).",
    );
  });
});

describe("a rejected key names the rung it was rejected on", () => {
  it("sends the Cloud rung to `vendo login`, never to a provider key", async () => {
    const controller = new DevModelController({
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: failingProvider("createAnthropic", unauthorized()),
    });
    const error = await rejection(controller.doStream({ prompt: [] }));
    expect(error.code).toBe("cloud-required");
    expect(error.message).toBe(
      "VENDO_API_KEY was rejected by the Vendo Cloud model gateway (401) — run `vendo login` to mint a fresh key "
      + "(it lands in .env.local), or manage project keys in the Vendo Cloud console.",
    );
  });

  it("sends an env-key rung to its own env var, never to `vendo login`", async () => {
    const refused = unauthorized();
    const controller = new DevModelController({
      env: { ...BYO.openai },
      importModule: failingProvider("createOpenAI", refused),
    });
    const error = await rejection(controller.doGenerate({ prompt: [] }));
    expect(error.code).toBe("validation");
    expect(error.message).toBe(
      "your OpenAI API key was rejected (401) — check OPENAI_API_KEY in .env.local; "
      + "a revoked or mistyped key fails exactly this way.",
    );
    expect(error.message).not.toContain("vendo login");
    // The provider's own error stays reachable for the operator log (request
    // ids, response headers) — the crafted message replaces it only on the wire.
    expect(error.cause).toBe(refused);

    // The same rail through the model the surfaces are handed: `vendo try`
    // probes resolve() for its capability flags, then serves turns with
    // controller.model() — the raw provider model would lose the rung.
    expect((await controller.resolve()).mode).toBe("delegate");
    const viaModel = await rejection(lazy(controller.model()).doStream({ prompt: [] }));
    expect(viaModel.message).toBe(error.message);
  });

  it("forwards the resolved provider's supportedUrls, and answers {} when nothing resolves", async () => {
    // The SDK reads supportedUrls to decide whether a remote image/PDF is sent
    // by URL or downloaded first. A wrapper claiming none makes callers fetch
    // files the provider could fetch itself — which fails outright under
    // restricted egress. Reading it must never throw, keyless included.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const patterns = { "image/*": [/^https:\/\/example\.test\/.*$/] };
    const controller = new DevModelController({
      env: { ...BYO.openai },
      importModule: failingProvider("createOpenAI", unauthorized(), patterns),
    });
    expect(await lazy(controller.model()).supportedUrls).toEqual(patterns);
    expect(await lazy(vendoModel(undefined, { env: {} })).supportedUrls).toEqual({});
  });

  it("leaves a 401 carrying the meter refusal to the pricing rail, and every other failure untouched", async () => {
    const refusal = unauthorized({ code: "meter-exhausted", meter: "ai_tokens" });
    const metered = new DevModelController({
      env: { VENDO_API_KEY: "vnd_x" },
      importModule: failingProvider("createAnthropic", refusal),
    });
    await expect(metered.doGenerate({ prompt: [] })).rejects.toBe(refusal);

    const overloaded = Object.assign(new Error("Overloaded"), { statusCode: 529 });
    const transient = new DevModelController({
      env: { ...BYO.anthropic },
      importModule: failingProvider("createAnthropic", overloaded),
    });
    await expect(transient.doGenerate({ prompt: [] })).rejects.toBe(overloaded);
  });
});

describe("end to end: a keyless turn through the real composed door", () => {
  it("streams the fix on the thread error frame, and doctor's live-turn check prints it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-onboarding-rails-"));
    const store = createStore({ dataDir });
    cleanups.push(async () => {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const vendo = createVendo({
      store,
      model: vendoModel(undefined, { env: {} }),
      principal: async () => ({ kind: "user", subject: "onboarding-user" }),
    });
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      vendo.handler(new Request(String(input), init))) as typeof fetch;

    // The thread's error frame — what the browser thread renders.
    const response = await fetchImpl("http://live.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: "msg_keyless", role: "user", parts: [{ type: "text", text: "hi" }] } }),
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    // The frame carries the sentence JSON-encoded, and the sentence quotes a code
    // snippet — models: { default: anthropic("claude-sonnet-4-6") } — so the raw
    // bytes contain the ESCAPED form. Compare against that, not the plain string,
    // or this passes for the wrong reason the day the message loses its quotes.
    const framed = JSON.stringify(`Vendo: ${NO_CREDENTIAL_MESSAGE} (validation)`).slice(1, -1);
    expect(stream).toContain(framed);
    expect(stream).not.toContain("An error occurred while generating the response.");

    // The same frame, read by `vendo doctor`'s live-turn check.
    const turn = await liveModelTurn({ base: "http://live.test/api/vendo", fetchImpl, env: {} });
    expect(turn.ok).toBe(false);
    expect(turn.error).toBe(`${NO_CREDENTIAL_MESSAGE} (validation)`);
    expect(turn.error).not.toBe("the turn returned an error frame");
  });
});
