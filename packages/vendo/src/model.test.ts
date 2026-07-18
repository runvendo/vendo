import { describe, expect, it, vi } from "vitest";
import { cloudModel, unconfiguredModel } from "./model.js";

type V3Model = {
  specificationVersion: "v3";
  provider: string;
  modelId: string;
  doGenerate(options: unknown): PromiseLike<unknown>;
  doStream(options: unknown): PromiseLike<{ stream: ReadableStream<unknown> }>;
};

const asV3 = (model: unknown): V3Model => model as V3Model;

const promptOptions = {
  prompt: [{ role: "user", content: [{ type: "text", text: "make a chart" }] }],
  temperature: 0.2,
};

const generatePayload = {
  content: [{ type: "text", text: "done" }],
  finishReason: { unified: "stop", raw: "end_turn" },
  usage: {
    inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  },
  warnings: [],
};

function ndjsonResponse(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

async function collect(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const parts: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

describe("cloudModel", () => {
  it("is an ai-SDK v3 model that generates through the console inference endpoint", async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
    const cloudFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return Response.json(generatePayload);
    });
    const model = asV3(cloudModel({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: cloudFetch as unknown as typeof fetch }));

    expect(model.specificationVersion).toBe("v3");
    expect(model.provider).toBe("vendo-cloud");

    const abort = new AbortController();
    const result = await model.doGenerate({ ...promptOptions, abortSignal: abort.signal, headers: { "x-host": "nope" } });
    expect(result).toEqual(generatePayload);
    expect(requests[0]).toMatchObject({
      url: "https://cloud.test/api/v1/inference",
      method: "POST",
      authorization: "Bearer vnd_secret",
      body: { mode: "generate", options: promptOptions },
    });
    // Non-serializable call plumbing never rides the wire.
    const sent = requests[0]!.body as { options: Record<string, unknown> };
    expect("abortSignal" in sent.options).toBe(false);
    expect("headers" in sent.options).toBe(false);
  });

  it("defaults the base URL to the Vendo console", async () => {
    const cloudFetch = vi.fn(async () => Response.json(generatePayload));
    await asV3(cloudModel({ apiKey: "vnd_secret", fetch: cloudFetch as unknown as typeof fetch })).doGenerate(promptOptions);
    expect(cloudFetch.mock.calls[0]![0]).toBe("https://console.vendo.run/api/v1/inference");
  });

  it("streams parts through verbatim and in order", async () => {
    const parts = [
      { type: "text-start", id: "text_1" },
      { type: "text-delta", id: "text_1", delta: "hel" },
      { type: "text-delta", id: "text_1", delta: "lo" },
      { type: "text-end", id: "text_1" },
      { type: "finish", usage: generatePayload.usage, finishReason: { unified: "stop", raw: null } },
    ];
    const cloudFetch = vi.fn(async () => ndjsonResponse(parts));
    const model = asV3(cloudModel({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: cloudFetch as unknown as typeof fetch }));
    const { stream } = await model.doStream(promptOptions);
    expect(await collect(stream)).toEqual(parts);
    const request = new Request(cloudFetch.mock.calls[0]![0] as URL, cloudFetch.mock.calls[0]![1] as RequestInit);
    expect(await request.json()).toEqual({ mode: "stream", options: promptOptions });
  });

  it("passes chunks through unbuffered: the first part arrives before the server writes the second", async () => {
    const encoder = new TextEncoder();
    let releaseSecond: () => void = () => {};
    const secondReleased = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "text-start", id: "text_1" })}\n`));
        await secondReleased;
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "text-end", id: "text_1" })}\n`));
        controller.close();
      },
    });
    const cloudFetch = vi.fn(async () => new Response(body, { status: 200 }));
    const model = asV3(cloudModel({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: cloudFetch as unknown as typeof fetch }));
    const { stream } = await model.doStream(promptOptions);
    const reader = stream.getReader();
    // If the client buffered the whole response, this read would deadlock:
    // the server only writes the second part after we observe the first.
    const first = await reader.read();
    expect(first.value).toEqual({ type: "text-start", id: "text_1" });
    releaseSecond();
    expect((await reader.read()).value).toEqual({ type: "text-end", id: "text_1" });
    expect((await reader.read()).done).toBe(true);
  });

  it("splits parts that arrive coalesced in one network chunk", async () => {
    const encoder = new TextEncoder();
    const one = JSON.stringify({ type: "text-start", id: "text_1" });
    const two = JSON.stringify({ type: "text-end", id: "text_1" });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // One network chunk carrying 1.5 lines, then the remainder.
        controller.enqueue(encoder.encode(`${one}\n${two.slice(0, 4)}`));
        controller.enqueue(encoder.encode(`${two.slice(4)}\n`));
        controller.close();
      },
    });
    const cloudFetch = vi.fn(async () => new Response(body, { status: 200 }));
    const model = asV3(cloudModel({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: cloudFetch as unknown as typeof fetch }));
    const { stream } = await model.doStream(promptOptions);
    expect(await collect(stream)).toEqual([
      { type: "text-start", id: "text_1" },
      { type: "text-end", id: "text_1" },
    ]);
  });

  it("maps an exhausted meter to the clear cloud-required error on the call", async () => {
    const cloudFetch = vi.fn(async () =>
      Response.json({ error: { code: "quota-exhausted", message: "Quota exhausted: upgrade or wait for period reset." } }, { status: 402 }));
    const model = asV3(cloudModel({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: cloudFetch as unknown as typeof fetch }));
    await expect(model.doGenerate(promptOptions)).rejects.toThrow(/quota exhausted/i);
    await expect(model.doStream(promptOptions)).rejects.toThrow(/quota exhausted/i);
  });
});

describe("unconfiguredModel", () => {
  it("fails closed with setup guidance", async () => {
    const model = asV3(unconfiguredModel());
    await expect(model.doGenerate(promptOptions)).rejects.toThrow(/model/i);
    await expect(model.doStream(promptOptions)).rejects.toThrow(/VENDO_API_KEY/);
  });
});

describe("adapter rule", () => {
  // Env prefixes an inference adapter could be tempted to sniff (cloned from
  // connections.test.ts and widened to the model-key vars, as that test asks).
  const WATCHED_ENV_PREFIXES = ["VENDO_", "ANTHROPIC_", "OPENAI_", "GOOGLE_"];

  it("no adapter reads the environment: behavior comes only from constructor arguments", async () => {
    const reads: string[] = [];
    const realEnv = process.env;
    process.env = new Proxy({
      ...realEnv,
      VENDO_API_KEY: "vnd_env",
      VENDO_CLOUD_URL: "https://env.test",
      ANTHROPIC_API_KEY: "sk-ant-env",
    }, {
      get(target, property) {
        if (typeof property === "string") reads.push(property);
        return target[property as keyof typeof target];
      },
    });
    try {
      const cloudFetch = vi.fn(async () => Response.json(generatePayload));
      const cloud = asV3(cloudModel({ apiKey: "vnd_arg", baseUrl: "https://arg.test", fetch: cloudFetch as unknown as typeof fetch }));
      await cloud.doGenerate(promptOptions);
      expect(cloudFetch.mock.calls[0]![0]).toBe("https://arg.test/api/v1/inference");

      const dark = asV3(unconfiguredModel());
      await expect(dark.doGenerate(promptOptions)).rejects.toThrow(/model/i);

      expect(reads.filter((key) => WATCHED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))).toEqual([]);
    } finally {
      process.env = realEnv;
    }
  });
});
