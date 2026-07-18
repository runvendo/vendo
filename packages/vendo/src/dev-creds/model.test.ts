import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DevModelController,
  devModel,
  devModelController,
  flattenPrompt,
  NO_CREDENTIAL_MESSAGE,
} from "./model.js";
import { writeDevSessionConsent } from "./resolve.js";

const probes = (claude: boolean, codex: boolean) => ({
  claude: async () => claude,
  codex: async () => codex,
});

describe("devModel", () => {
  it("is an ai-SDK LanguageModel carrying the dev-ladder marker", () => {
    const model = devModel({ env: {}, probes: probes(false, false) });
    const controller = devModelController(model);
    expect(controller).not.toBeNull();
    const record = model as unknown as Record<string, unknown>;
    expect(record.specificationVersion).toBe("v3");
    expect(record.provider).toBe("vendo-dev");
    // A host's own model has no controller.
    expect(devModelController({ specificationVersion: "v3" })).toBeNull();
    expect(devModelController("claude-sonnet-4-6")).toBeNull();
  });

  it("fails every call with the honest ladder instructions when nothing is available", async () => {
    const model = devModel({ env: {}, probes: probes(false, false) });
    const record = model as unknown as {
      doGenerate(options: unknown): Promise<unknown>;
      doStream(options: unknown): Promise<unknown>;
    };
    await expect(record.doGenerate({ prompt: [] })).rejects.toThrow(NO_CREDENTIAL_MESSAGE);
    // doStream rejects with the same message (streamText's error path shows
    // the generic error part; the operator log carries this one).
    await expect(record.doStream({ prompt: [] })).rejects.toThrow(NO_CREDENTIAL_MESSAGE);
  });

  it("refuses session rungs in production with the real-key message", async () => {
    const controller = new DevModelController({
      env: { NODE_ENV: "production" },
      probes: probes(true, true),
    });
    await expect(controller.doGenerate({ prompt: [] })).rejects.toThrow(/Production always needs a real key/);
    expect(await controller.chatSession("thr_1")).toBeNull();
  });

  it("names the missing provider install for an env-key rung without the package", async () => {
    const controller = new DevModelController({
      env: { OPENAI_API_KEY: "sk-o" },
      probes: probes(false, false),
      importModule: async (_root, specifier) => {
        throw new Error(`Cannot find module '${specifier}'`);
      },
    });
    await expect(controller.doGenerate({ prompt: [] })).rejects.toThrow(/@ai-sdk\/openai@\^3/);
    // Key rungs never ride a session: the chat loop stays native.
    expect(await controller.chatSession("thr_1")).toBeNull();
  });

  it("delegates env-key calls to the host provider model with full fidelity", async () => {
    const seen: unknown[] = [];
    const controller = new DevModelController({
      env: { ANTHROPIC_API_KEY: "sk-a" },
      probes: probes(false, false),
      importModule: async () => ({
        createAnthropic: (config: { apiKey: string }) => {
          seen.push(config.apiKey);
          return (modelId: string) => ({
            specificationVersion: "v3",
            provider: "anthropic",
            modelId,
            supportedUrls: {},
            doGenerate: async (options: unknown) => ({ delegated: "generate", options }),
            doStream: async (options: unknown) => ({ delegated: "stream", options }),
          });
        },
      }),
    });
    const callOptions = { prompt: [], tools: [{ name: "t" }] };
    expect(await controller.doGenerate(callOptions)).toEqual({ delegated: "generate", options: callOptions });
    expect(await controller.doStream(callOptions)).toEqual({ delegated: "stream", options: callOptions });
    expect(seen).toEqual(["sk-a"]);
    // Key rungs never ride a session: the chat loop stays native.
    expect(await controller.chatSession("thr_1")).toBeNull();
  });
});

describe("vendo-cloud rung", () => {
  it("delegates to Vendo Cloud managed inference through the console endpoint", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return Response.json({ content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: null }, usage: {}, warnings: [] });
    }) as unknown as typeof fetch;
    const controller = new DevModelController({
      env: { VENDO_API_KEY: `vnd_${"a".repeat(40)}`, VENDO_CLOUD_URL: "https://cloud.test" },
      probes: probes(false, false),
      fetchImpl,
    });
    const result = await controller.doGenerate({ prompt: [] }) as { content: unknown[] };
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/inference",
      authorization: `Bearer vnd_${"a".repeat(40)}`,
      body: { mode: "generate", options: { prompt: [] } },
    });
    // Key rungs never ride a session: the chat loop stays native.
    expect(await controller.chatSession("thr_1")).toBeNull();
  });
});

describe("session-rung chat sessions", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vendo-dev-model-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("requires recorded consent before handing out a session", async () => {
    const controller = new DevModelController({ root, env: {}, probes: probes(false, true) });
    expect(await controller.chatSession("thr_1")).toBeNull();
    await expect(controller.doGenerate({ prompt: [] })).rejects.toThrow(/no recorded consent/);
  });

  it("hands out one persistent session per thread once consented", async () => {
    await writeDevSessionConsent(root, "codex-session");
    const controller = new DevModelController({ root, env: {}, probes: probes(false, true) });
    const first = await controller.chatSession("thr_1");
    expect(first).not.toBeNull();
    expect(await controller.chatSession("thr_1")).toBe(first);
    const second = await controller.chatSession("thr_2");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it("accepts VENDO_DEV_ALLOW_SESSIONS=1 as consent", async () => {
    const controller = new DevModelController({
      root,
      env: { VENDO_DEV_ALLOW_SESSIONS: "1" },
      probes: probes(true, false),
    });
    expect(await controller.chatSession("thr_1")).not.toBeNull();
  });
});

describe("flattenPrompt", () => {
  it("splits system strings from user/assistant text turns", () => {
    const { system, text } = flattenPrompt([
      { role: "system", content: "Be helpful." },
      { role: "user", content: [{ type: "text", text: "Hi." }] },
      { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
      { role: "user", content: [{ type: "text", text: "Make a dashboard." }] },
    ]);
    expect(system).toBe("Be helpful.");
    expect(text).toBe("Hi.\n\n[assistant] Hello!\n\nMake a dashboard.");
  });

  it("degrades to a blank turn on an empty prompt", () => {
    expect(flattenPrompt(undefined)).toEqual({ system: "", text: " " });
  });
});
