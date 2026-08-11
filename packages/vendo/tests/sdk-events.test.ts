import type { VendoUsageEvent } from "@vendoai/core";
import { consoleLogger, setLogger, setUsageSink } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBatchedUploader } from "../src/batched-uploader.js";
import { createSdkEvents, sdkRuntime, vendoFrames, withSdkErrorReporting } from "../src/sdk-events.js";
import { VERSION } from "../src/wire/shared.js";

/**
 * The SDK-events pipeline: the Cloud half of core's closed `VendoUsageEvent`
 * catalog. Its consent contract is the capability-miss one (a Cloud key plus
 * `envOptOut`), so the cases below mirror that suite deliberately — the two
 * streams must never disagree about when Vendo is allowed to speak.
 */

const okJson = (body: unknown = { accepted: 1 }): Response =>
  Response.json(body as Record<string, unknown>, { status: 202 });

const event = (name: string): VendoUsageEvent => ({
  name: "guard_decision",
  kind: name,
  decision: "run",
  tool: null,
});

const spies = () => ({
  debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
  log: vi.spyOn(console, "log").mockImplementation(() => {}),
  warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  error: vi.spyOn(console, "error").mockImplementation(() => {}),
});

afterEach(() => {
  // A leaked sink or logger is another suite's failure, not this one's.
  setUsageSink(undefined);
  setLogger(undefined);
  vi.restoreAllMocks();
});

describe("the consent contract", () => {
  it("is undefined with no Cloud slot — the key is the opt-in", () => {
    expect(createSdkEvents({ env: {}, runtime: "node" })).toBeUndefined();
  });

  it.each([
    ["VENDO_TELEMETRY_DISABLED", { VENDO_TELEMETRY_DISABLED: "true" }],
    ["DO_NOT_TRACK", { DO_NOT_TRACK: "1" }],
    ["CI", { CI: "true" }],
  ])("honors the %s environment opt-out", (_name, optOut) => {
    expect(createSdkEvents({
      cloud: { apiKey: "vnd_test" },
      env: { ...optOut },
      runtime: "node",
    })).toBeUndefined();
  });

  it("runs in production — NODE_ENV never gates the stream", async () => {
    const fetchImpl = vi.fn(async () => okJson());
    const pipeline = createSdkEvents({
      cloud: { apiKey: "vnd_test" },
      env: { NODE_ENV: "production" },
      runtime: "node",
      fetchImpl,
    });

    pipeline?.record(event("tool-call"));
    await pipeline?.flush();

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("the wire body", () => {
  it("is version + runtime + the batch, and carries no deployment identity", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return okJson();
    });
    const pipeline = createSdkEvents({
      cloud: { apiKey: "vnd_test_key" },
      env: {},
      runtime: "workerd",
      fetchImpl,
    });

    pipeline?.record(event("tool-call"));
    pipeline?.record(event("approval"));
    await pipeline?.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://console.vendo.run/api/v1/telemetry");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer vnd_test_key", "content-type": "application/json" },
    });
    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    // The console resolves org/project/deployment from the identity headers
    // server-side. Naming any of them in the body would let a deployment claim
    // to be another one.
    expect(Object.keys(body)).toEqual(["version", "runtime", "events"]);
    expect(body).toEqual({
      version: VERSION,
      runtime: "workerd",
      events: [event("tool-call"), event("approval")],
    });
  });
});

describe("the kill switch", () => {
  it("stops every further send for the rest of the process lifetime", async () => {
    const fetchImpl = vi.fn(async () => okJson({ disabled: true }));
    const pipeline = createSdkEvents({
      cloud: { apiKey: "vnd_test" },
      env: {},
      runtime: "node",
      fetchImpl,
    });

    pipeline?.record(event("tool-call"));
    await pipeline?.flush();
    expect(fetchImpl).toHaveBeenCalledOnce();

    pipeline?.record(event("approval"));
    await pipeline?.flush();

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("the error-reporting logger wrapper", () => {
  it("prints exactly what the unwrapped logger printed, level for level", () => {
    const cases = [
      { level: "debug", method: "debug" },
      { level: "info", method: "log" },
      { level: "warn", method: "warn" },
      { level: "error", method: "error" },
    ] as const;
    for (const { level, method } of cases) {
      const err = new Error("boom");
      const bare = spies();
      consoleLogger({ code: "vendo.x", level, message: "[vendo] x:", data: { path: "a.ts", err } });
      const expected = bare[method].mock.calls;
      vi.restoreAllMocks();

      const wrapped = spies();
      withSdkErrorReporting(consoleLogger)(
        { code: "vendo.x", level, message: "[vendo] x:", data: { path: "a.ts", err } },
      );
      expect(wrapped[method].mock.calls).toEqual(expected);
      vi.restoreAllMocks();
    }
  });

  it("enqueues an sdk_error for warn and error, and for nothing else", () => {
    spies();
    const seen: VendoUsageEvent[] = [];
    setUsageSink((usage) => seen.push(usage));
    const logger = withSdkErrorReporting(consoleLogger);

    logger({ code: "vendo.debug", level: "debug", message: "[vendo] d" });
    logger({ code: "vendo.info", level: "info", message: "[vendo] i" });
    expect(seen).toEqual([]);

    logger({ code: "guard.org-policy", level: "warn", message: "[vendo] w" });
    logger({ code: "vendo.boom", level: "error", message: "[vendo] e", data: { count: 2 } });

    expect(seen.map((usage) => usage.name)).toEqual(["sdk_error", "sdk_error"]);
    expect(seen[0]).toMatchObject({ code: "guard.org-policy", level: "warn", message: "[vendo] w" });
    expect(seen[1]).toMatchObject({ code: "vendo.boom", level: "error", message: "[vendo] e" });
  });

  it("carries data as SHAPES, never the values a call site logged", () => {
    spies();
    const seen: VendoUsageEvent[] = [];
    setUsageSink((usage) => seen.push(usage));

    withSdkErrorReporting(consoleLogger)({
      code: "vendo.boom",
      level: "error",
      message: "[vendo] e",
      data: { path: "/home/someone/app/secrets.ts", count: 2, err: new TypeError("nope") },
    });

    expect(seen[0]).toMatchObject({
      data: { path: "string", count: "number", err: "TypeError" },
      runtime: sdkRuntime(),
    });
  });
});

describe("vendoFrames", () => {
  it("keeps the @vendoai frames and drops the host application's own", () => {
    const stack = [
      "Error",
      "    at log (/home/someone/app/node_modules/@vendoai/core/dist/log.js:42:7)",
      "    at handler (/home/someone/app/src/app/api/chat/route.ts:12:3)",
      "    at check (/home/someone/app/node_modules/@vendoai/guard/dist/guard.js:900:5)",
    ].join("\n");

    expect(vendoFrames(stack)).toEqual([
      "@vendoai/core/dist/log.js:42:7",
      "@vendoai/guard/dist/guard.js:900:5",
    ]);
    expect(vendoFrames(undefined)).toEqual([]);
  });
});

describe("the batched uploader the miss stream and this one share", () => {
  const uploader = (
    fetchImpl: typeof fetch,
    knobs: Partial<Parameters<typeof createBatchedUploader>[0]> = {},
  ) => createBatchedUploader<VendoUsageEvent>({
    path: "/api/v1/telemetry",
    cloud: { apiKey: "vnd_test" },
    body: (events) => ({ events }),
    accept: () => true,
    fetchImpl,
    batchDelayMs: 60_000,
    ...knobs,
  });

  it("sends one request per batch of batchSize", async () => {
    const batches: number[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      batches.push((JSON.parse(String(init?.body)) as { events: unknown[] }).events.length);
      return okJson();
    });
    const stream = uploader(fetchImpl as unknown as typeof fetch, { batchSize: 100 });

    for (let index = 0; index < 150; index += 1) stream.enqueue(event(`e_${index}`));
    await stream.flush();

    expect(batches).toEqual([100, 50]);
  });

  it("drops events over the queue cap rather than growing without bound", async () => {
    const batches: number[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      batches.push((JSON.parse(String(init?.body)) as { events: unknown[] }).events.length);
      return okJson();
    });
    const stream = uploader(fetchImpl as unknown as typeof fetch, { queueLimit: 3, batchSize: 100 });

    for (let index = 0; index < 9; index += 1) stream.enqueue(event(`e_${index}`));
    await stream.flush();

    expect(batches).toEqual([3]);
  });

  it("retries a failed batch within a bound and then drops only the Cloud copy", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValueOnce(okJson());
    const stream = uploader(fetchImpl, { retryDelaysMs: [0, 0] });

    stream.enqueue(event("e_retry"));
    await stream.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("gives up after the last retry delay without throwing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const stream = uploader(fetchImpl, { retryDelaysMs: [0] });

    stream.enqueue(event("e_gone"));
    await expect(stream.flush()).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
