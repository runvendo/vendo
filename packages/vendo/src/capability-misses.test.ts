import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityMissEvent, ToolDescriptor } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendCapabilityMiss,
  createCapabilityMissCapture,
  capabilitySurfaceSnapshot,
} from "./capability-misses.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const hash = `sha256:${"c".repeat(64)}`;
const surface = {
  hash,
  tools: [
    { name: "host_accounts_list", risk: "read" as const },
    { name: "host_transactions_export", risk: "write" as const },
  ],
};

function event(id: string): CapabilityMissEvent {
  return {
    format: "vendo/capability-miss@1",
    id,
    at: "2026-07-14T20:00:00.000Z",
    hostId: "host_maple",
    sessionId: "session_01",
    intent: "Export transactions",
    surface: { format: "vendo/tools@1", hash },
    trigger: { kind: "no-matching-tool", toolsConsidered: ["host_accounts_list"] },
  };
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("capability-miss local sink", () => {
  it("appends one JSON object per line safely under concurrent writes", async () => {
    const dataDir = await tempDir("vendo-misses-");
    const events = Array.from({ length: 40 }, (_, index) => event(`mis_${index}`));

    await Promise.all(events.map((miss) => appendCapabilityMiss(miss, { dataDir })));

    const lines = (await readFile(join(dataDir, "misses.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(events.length);
    expect(new Set(lines.map((line) => (JSON.parse(line) as CapabilityMissEvent).id)))
      .toEqual(new Set(events.map((miss) => miss.id)));
  });

  it("never rejects the agent path when the local sink fails", async () => {
    const capture = createCapabilityMissCapture({
      env: {},
      telemetryConfig: { anonymousId: "host_sink_failure", optedOut: false },
      surface: Promise.resolve(surface),
      append: async () => { throw new Error("disk full"); },
    });

    expect(() => capture.record(event("mis_disk_full"))).not.toThrow();
    await expect(capture.flush()).resolves.toBeUndefined();
  });
});

describe("capability-miss Cloud upload", () => {
  it("uses the persisted telemetry anonymous id as the normative host id", async () => {
    const home = await tempDir("vendo-miss-home-");
    await mkdir(join(home, ".vendo"), { recursive: true });
    await writeFile(join(home, ".vendo", "telemetry.json"), JSON.stringify({
      anonymousId: "telemetry-installation-id",
      optedOut: false,
      noticeShown: true,
    }));

    const capture = createCapabilityMissCapture({
      env: {},
      telemetryHome: home,
      surface: Promise.resolve(surface),
      append: async () => {},
    });

    expect(capture.hostId).toBe("telemetry-installation-id");
  });

  it("keeps local capture but sends nothing without a key or after telemetry opt-out", async () => {
    const append = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>();
    const noKey = createCapabilityMissCapture({
      env: {},
      surface: Promise.resolve(surface),
      append,
      fetchImpl,
      telemetryConfig: { anonymousId: "host_no_key", optedOut: false },
    });
    const optedOut = createCapabilityMissCapture({
      env: { VENDO_API_KEY: "vnd_test", NODE_ENV: "development" },
      surface: Promise.resolve(surface),
      append,
      fetchImpl,
      telemetryConfig: { anonymousId: "host_opted_out", optedOut: true },
    });

    noKey.record(event("mis_no_key"));
    optedOut.record(event("mis_opted_out"));
    await Promise.all([noKey.flush(), optedOut.flush()]);

    expect(append).toHaveBeenCalledTimes(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["VENDO_TELEMETRY_DISABLED", { VENDO_TELEMETRY_DISABLED: "true" }],
    ["DO_NOT_TRACK", { DO_NOT_TRACK: "1" }],
    ["CI", { CI: "true" }],
  ])("honors the %s environment opt-out for Cloud only", async (_name, optOut) => {
    const append = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>();
    const capture = createCapabilityMissCapture({
      env: { VENDO_API_KEY: "vnd_test", ...optOut },
      surface: Promise.resolve(surface),
      append,
      fetchImpl,
      telemetryConfig: { anonymousId: "host_env_opt_out", optedOut: false },
    });

    capture.record(event(`mis_${_name.toLowerCase()}`));
    await capture.flush();

    expect(append).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed outside development and test runtime environments", async () => {
    const append = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>();
    const capture = createCapabilityMissCapture({
      env: { VENDO_API_KEY: "vnd_test", NODE_ENV: "production" },
      telemetryConfig: { anonymousId: "host_production", optedOut: false },
      surface: Promise.resolve(surface),
      append,
      fetchImpl,
    });

    capture.record(event("mis_production"));
    await capture.flush();

    expect(append).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("batches events into the exact console request with the canonical enabled surface", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return Response.json({ accepted: 3, duplicates: 0 }, { status: 202 });
    });
    const capture = createCapabilityMissCapture({
      env: {
        VENDO_API_KEY: "vnd_test_key",
        VENDO_CLOUD_URL: "https://cloud.example.test/",
        NODE_ENV: "development",
      },
      surface: Promise.resolve(surface),
      append: async () => {},
      fetchImpl,
      telemetryConfig: { anonymousId: "host_batch", optedOut: false },
      batchDelayMs: 60_000,
    });
    const events = [event("mis_batch_1"), event("mis_batch_2"), event("mis_batch_3")];

    for (const miss of events) capture.record(miss);
    await capture.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://cloud.example.test/api/v1/misses");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: "Bearer vnd_test_key",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ surface, events });
  });

  it("retries a failed batch within a bound and then drops only the Cloud copy", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValueOnce(Response.json({ accepted: 1, duplicates: 0 }, { status: 202 }));
    const append = vi.fn(async () => {});
    const capture = createCapabilityMissCapture({
      env: { VENDO_API_KEY: "vnd_test_key", NODE_ENV: "development" },
      surface: Promise.resolve(surface),
      append,
      fetchImpl,
      telemetryConfig: { anonymousId: "host_retry", optedOut: false },
      retryDelaysMs: [0, 0],
      batchDelayMs: 60_000,
    });

    capture.record(event("mis_retry"));
    await capture.flush();

    expect(append).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("bounds a hung Cloud request without delaying or losing the local copy", async () => {
    const append = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const capture = createCapabilityMissCapture({
      env: { VENDO_API_KEY: "vnd_test_key", NODE_ENV: "test" },
      telemetryConfig: { anonymousId: "host_timeout", optedOut: false },
      surface: Promise.resolve(surface),
      append,
      fetchImpl,
      requestTimeoutMs: 1,
      retryDelaysMs: [],
      batchDelayMs: 60_000,
    });

    capture.record(event("mis_timeout"));
    await expect(capture.flush()).resolves.toBeUndefined();

    expect(append).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("capability surface identity", () => {
  it("hashes a sorted compact enabled-tool surface canonically", () => {
    const descriptors: ToolDescriptor[] = [
      { name: "z_tool", description: "Z", inputSchema: { type: "object" }, risk: "write" },
      { name: "a_tool", description: "A", inputSchema: { type: "object" }, risk: "read" },
    ];

    const first = capabilitySurfaceSnapshot(descriptors);
    const second = capabilitySurfaceSnapshot([...descriptors].reverse());

    expect(first).toEqual(second);
    expect(first.tools).toEqual([
      { name: "a_tool", risk: "read" },
      { name: "z_tool", risk: "write" },
    ]);
    expect(first.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
