import { describe, expect, it, vi } from "vitest";
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import { cloudSandbox } from "./sandbox.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  deploymentHost: string | null;
  deploymentName: string | null;
  json?: unknown;
  bytes?: Uint8Array;
}

/** In-memory fake of the console's /api/v1/sandboxes surface (the wire the
 * adapter must speak — see apps/console/lib/api/sandbox-handlers.ts). */
function fakeConsole() {
  const requests: RecordedRequest[] = [];
  const machines = new Map<string, {
    state: "live" | "paused" | "stopped";
    files: Map<string, Uint8Array>;
  }>();
  const snapshots = new Map<string, string>();
  let minted = 0;

  const json = (body: unknown, status = 200): Response =>
    Response.json(body, { status });

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const recorded: RecordedRequest = {
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      deploymentHost: request.headers.get("x-vendo-deployment-host"),
      deploymentName: request.headers.get("x-vendo-deployment-name"),
    };
    const raw = new Uint8Array(await request.arrayBuffer());
    if (recorded.contentType === "application/json") {
      recorded.json = JSON.parse(decoder.decode(raw));
    } else if (raw.length > 0) {
      recorded.bytes = raw;
    }
    requests.push(recorded);

    const path = url.pathname;
    if (path === "/api/v1/sandboxes" && request.method === "POST") {
      const body = recorded.json as { files?: Record<string, string> };
      const id = `m_${String(++minted).padStart(24, "0")}`;
      const files = new Map<string, Uint8Array>();
      for (const [filePath, data] of Object.entries(body.files ?? {})) {
        files.set(filePath, fromBase64(data));
      }
      machines.set(id, { state: "live", files });
      return json({ id, url: `https://${id}.m.vendo.run` }, 201);
    }
    if (path === "/api/v1/sandboxes/resume" && request.method === "POST") {
      const { ref } = recorded.json as { ref: string };
      const id = snapshots.get(ref);
      const machine = id === undefined ? undefined : machines.get(id);
      if (id === undefined || machine === undefined) {
        return json({ error: { code: "not-found", message: "Snapshot not found." } }, 404);
      }
      machine.state = "live";
      return json({ id, url: `https://${id}.m.vendo.run` });
    }

    const match = /^\/api\/v1\/sandboxes\/([^/]+)(\/.*)?$/.exec(path);
    const machine = match ? machines.get(match[1]!) : undefined;
    if (!match || machine === undefined) {
      return json({ error: { code: "not-found", message: "Sandbox not found." } }, 404);
    }
    const [, id, rest] = match;
    if (machine.state !== "live" && request.method !== "DELETE") {
      return json({ error: { code: "conflict", message: `Sandbox is ${machine.state}.` } }, 409);
    }
    switch (`${request.method} ${rest ?? ""}`) {
      case "POST /exec":
        return json({ code: 0, stdout: "ran", stderr: "" });
      case "GET /files": {
        const bytes = machine.files.get(url.searchParams.get("path") ?? "");
        if (bytes === undefined) {
          return json({ error: { code: "not-found", message: "File not found." } }, 404);
        }
        return new Response(bytes.slice().buffer as ArrayBuffer, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      case "PUT /files":
        machine.files.set(url.searchParams.get("path") ?? "", recorded.bytes ?? new Uint8Array());
        return json({ ok: true });
      case "GET /files/list": {
        const dir = url.searchParams.get("dir") ?? "";
        const entries = [...machine.files.keys()]
          .filter((filePath) => filePath.startsWith(`${dir}/`))
          .map((filePath) => filePath.slice(dir.length + 1));
        return json({ entries });
      }
      case "POST /request": {
        const body = recorded.json as { path: string; body_b64?: string };
        return json({
          status: 200,
          headers: { "x-echo-path": body.path },
          body_b64: body.body_b64 ?? "",
        });
      }
      case "POST /snapshot": {
        const ref = `vendo:snap_${"0".repeat(38)}${String(minted).padStart(2, "0")}`;
        snapshots.set(ref, id!);
        machine.state = "paused";
        return json({ ref });
      }
      case "GET /screenshot":
        return new Response(new Uint8Array([137, 80]).slice().buffer as ArrayBuffer, {
          headers: { "content-type": "image/png" },
        });
      case "DELETE ":
        machine.state = "stopped";
        return json({ ok: true });
      default:
        return json({ error: { code: "not-found", message: "Sandbox not found." } }, 404);
    }
  };

  return { requests, machines, handler };
}

/** The one consumer routine, typed against the frozen 06-apps §3 seam. Running
 * it against a BYO-style in-memory adapter AND the Cloud adapter proves the
 * generation pipeline can hold either behind the same interface. */
async function exerciseThroughSeam(adapter: SandboxAdapter): Promise<string> {
  const created = await adapter.create({
    env: { PORT: "8080" },
    files: { "/app/seed.txt": "seed" },
    egress: ["api.example.com"],
  });
  expect(decoder.decode(await created.files.read("/app/seed.txt"))).toBe("seed");
  await created.files.write("/app/round-trip.bin", encoder.encode("survives"));
  expect(await created.files.list("/app")).toEqual(
    expect.arrayContaining(["round-trip.bin"]),
  );
  expect(await created.exec("echo hi", { cwd: "/app", timeoutMs: 5_000 })).toMatchObject({ code: 0 });
  const proxied = await created.request({ method: "POST", path: "/fn/echo", body: encoder.encode("ping") });
  expect(proxied.status).toBe(200);
  expect(proxied.body).toBeInstanceOf(Uint8Array);
  const ref = await created.snapshot();
  const resumed = await adapter.resume(ref);
  expect(resumed.id).toBe(created.id);
  await resumed.stop();
  return ref;
}

function byoStyleAdapter(): SandboxAdapter {
  const machines = new Map<string, Map<string, Uint8Array>>();
  const wrap = (id: string, files: Map<string, Uint8Array>): SandboxMachine => ({
    id,
    request: async (req) => ({
      status: 200,
      headers: {},
      body: typeof req.body === "string" ? encoder.encode(req.body) : req.body ?? new Uint8Array(),
    }),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    files: {
      read: async (path) => {
        const bytes = files.get(path);
        if (bytes === undefined) throw new Error(`missing ${path}`);
        return bytes;
      },
      write: async (path, bytes) => {
        files.set(path, typeof bytes === "string" ? encoder.encode(bytes) : bytes);
      },
      list: async (dir) => [...files.keys()]
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => path.slice(dir.length + 1)),
    },
    snapshot: async () => `byo:v1:${id}`,
    stop: async () => undefined,
  });
  return {
    create: async (spec) => {
      const id = `byo_${machines.size + 1}`;
      const files = new Map(Object.entries(spec.files ?? {}).map(([path, data]) => [
        path,
        typeof data === "string" ? encoder.encode(data) : data,
      ]));
      machines.set(id, files);
      return wrap(id, files);
    },
    resume: async (ref) => {
      const id = ref.slice("byo:v1:".length);
      return wrap(id, machines.get(id) ?? new Map());
    },
  };
}

describe("cloudSandbox", () => {
  it("BYO and Cloud adapters serve the same generation-facing seam", async () => {
    // BYO leg: an in-memory adapter standing in for e2bSandbox/modalSandbox
    // (their provider conformance lives in @vendoai/apps). Cloud leg: the
    // console wire behind stubbed HTTP. Same routine, same interface.
    await exerciseThroughSeam(byoStyleAdapter());

    const console_ = fakeConsole();
    const ref = await exerciseThroughSeam(cloudSandbox({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: console_.handler as unknown as typeof fetch,
    }));
    expect(ref).toMatch(/^vendo:snap_/);
    // Every request carried the org key AND the deployment identity (the
    // console meters usage from real traffic); nothing spoke to the provider
    // directly.
    expect(console_.requests.length).toBeGreaterThan(0);
    for (const request of console_.requests) {
      expect(request.authorization).toBe("Bearer vnd_secret");
      expect(request.url).toContain("https://cloud.test/api/v1/sandboxes");
      expect(request.deploymentHost).toEqual(expect.any(String));
      expect(request.deploymentHost).not.toBe("");
      expect(request.deploymentName).toEqual(expect.any(String));
      expect(request.deploymentName).not.toBe("");
    }
  });

  it("speaks the console wire shapes exactly", async () => {
    const console_ = fakeConsole();
    const adapter = cloudSandbox({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test/",
      fetch: console_.handler as unknown as typeof fetch,
    });
    const machine = await adapter.create({
      env: { PORT: "8080" },
      files: { "/app/a.bin": new Uint8Array([0, 1, 2, 255]), "/app/b.txt": "text" },
      egress: [],
    });
    expect(machine.id).toMatch(/^m_/);
    expect(console_.requests[0]).toMatchObject({
      method: "POST",
      url: "https://cloud.test/api/v1/sandboxes",
      json: {
        env: { PORT: "8080" },
        files: { "/app/a.bin": toBase64(new Uint8Array([0, 1, 2, 255])), "/app/b.txt": toBase64(encoder.encode("text")) },
        egress: [],
      },
    });

    await machine.exec("pwd", { cwd: "/app", timeoutMs: 9_000 });
    expect(console_.requests[1]).toMatchObject({
      method: "POST",
      url: `https://cloud.test/api/v1/sandboxes/${machine.id}/exec`,
      json: { cmd: "pwd", cwd: "/app", timeout_ms: 9_000 },
    });

    await machine.files.write("/tmp/raw", new Uint8Array([5, 6]));
    expect(console_.requests[2]).toMatchObject({
      method: "PUT",
      url: `https://cloud.test/api/v1/sandboxes/${machine.id}/files?path=%2Ftmp%2Fraw`,
      contentType: "application/octet-stream",
      bytes: new Uint8Array([5, 6]),
    });

    const proxied = await machine.request({
      method: "POST",
      path: "fn/echo", // missing leading slash is normalized, e2b-adapter parity
      headers: { "x-test": "yes" },
      body: "ping",
    });
    expect(console_.requests[3]).toMatchObject({
      json: {
        method: "POST",
        path: "/fn/echo",
        headers: { "x-test": "yes" },
        body_b64: toBase64(encoder.encode("ping")),
      },
    });
    expect(decoder.decode(proxied.body)).toBe("ping");
    expect(proxied.headers["x-echo-path"]).toBe("/fn/echo");

    expect(await machine.url?.(8080)).toBe(`https://${machine.id}.m.vendo.run`);
    const screenshot = await machine.screenshot?.();
    expect(screenshot).toEqual(new Uint8Array([137, 80]));

    await machine.stop();
    expect(console_.requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: `https://cloud.test/api/v1/sandboxes/${machine.id}`,
    });
  });

  it("defaults the base URL to the Vendo console", async () => {
    const cloudFetch = vi.fn(async () =>
      Response.json({ id: `m_${"0".repeat(24)}`, url: "https://m.test" }, { status: 201 }));
    const adapter = cloudSandbox({ apiKey: "vnd_secret", fetch: cloudFetch as unknown as typeof fetch });
    await adapter.create({ env: {} });
    expect(cloudFetch.mock.calls[0]![0]).toBe("https://console.vendo.run/api/v1/sandboxes");
  });

  it("maps an exhausted sandbox_minutes meter to the binding cloud-required error on create and resume", async () => {
    const exhausted = vi.fn(async () => Response.json(
      { error: { code: "quota-exhausted", message: "Sandbox minutes quota exhausted.", meter: "sandbox_minutes" } },
      { status: 402 },
    ));
    const adapter = cloudSandbox({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: exhausted as unknown as typeof fetch });
    await expect(adapter.create({ env: {} })).rejects.toMatchObject({
      code: "cloud-required",
      message: "Sandbox minutes quota exhausted.",
    });
    await expect(adapter.resume(`vendo:snap_${"a".repeat(40)}`)).rejects.toMatchObject({
      code: "cloud-required",
      message: "Sandbox minutes quota exhausted.",
    });
  });

  it("maps a rejected key (401) to cloud-required with the server's message", async () => {
    const denied = vi.fn(async () => Response.json(
      { error: { code: "unauthorized", message: "Invalid API key." } },
      { status: 401 },
    ));
    const adapter = cloudSandbox({ apiKey: "vnd_revoked", baseUrl: "https://cloud.test", fetch: denied as unknown as typeof fetch });
    await expect(adapter.create({ env: {} })).rejects.toMatchObject({
      code: "cloud-required",
      message: "Invalid API key.",
    });
  });

  it("treats malformed 200 responses as sandbox-unavailable — console garbage is never the caller's fault", async () => {
    const adapterFor = (fetchImpl: unknown) =>
      cloudSandbox({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: fetchImpl as typeof fetch });
    // A stub whose FIRST response is a valid machine handle, then garbage.
    const handleThen = (garbage: unknown) => {
      let first = true;
      return vi.fn(async () => {
        if (first) {
          first = false;
          return Response.json({ id: `m_${"0".repeat(24)}`, url: "https://m.test" }, { status: 201 });
        }
        return Response.json(garbage);
      });
    };
    const machineFor = async (garbage: unknown): Promise<SandboxMachine> =>
      adapterFor(handleThen(garbage)).create({ env: {} });

    // Missing machine handle on create and resume.
    await expect(adapterFor(vi.fn(async () => Response.json({}))).create({ env: {} }))
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: /no machine handle/ });
    await expect(adapterFor(vi.fn(async () => Response.json({ id: 42, url: null }))).resume(`vendo:snap_${"a".repeat(40)}`))
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: /no machine handle/ });

    // Invalid exec response (no numeric code).
    await expect((await machineFor({ stdout: "but no code" })).exec("pwd"))
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: /invalid exec response/ });

    // Invalid proxy response (no body_b64).
    await expect((await machineFor({ status: 200, headers: {} })).request({ method: "GET", path: "/" }))
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: /invalid proxy response/ });

    // Well-shaped proxy response carrying invalid base64.
    await expect(
      (await machineFor({ status: 200, headers: {}, body_b64: "!!not-base64!!" })).request({ method: "GET", path: "/" }),
    ).rejects.toMatchObject({ code: "sandbox-unavailable", message: /invalid base64/ });

    // Missing snapshot ref.
    await expect((await machineFor({})).snapshot())
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: /no snapshot reference/ });

    // Non-string proxy header values are dropped, not passed through.
    const mixed = await (await machineFor({
      status: 200,
      headers: { "x-ok": "yes", "x-bad": 42, "x-worse": { nested: true } },
      body_b64: "",
    })).request({ method: "GET", path: "/" });
    expect(mixed.headers).toEqual({ "x-ok": "yes" });
  });

  it("preserves the console's error codes and falls back to sandbox-unavailable", async () => {
    const respond = (code: string, message: string, status: number) =>
      vi.fn(async () => Response.json({ error: { code, message } }, { status }));
    const adapterFor = (fetchImpl: unknown) =>
      cloudSandbox({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: fetchImpl as typeof fetch });

    await expect(adapterFor(respond("not-found", "Snapshot not found.", 404)).resume(`vendo:snap_${"a".repeat(40)}`))
      .rejects.toMatchObject({ code: "not-found" });
    await expect(adapterFor(respond("conflict", "Sandbox is paused.", 409)).create({ env: {} }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(adapterFor(respond("unavailable", "Sandbox provider is unavailable.", 503)).create({ env: {} }))
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: "Sandbox provider is unavailable." });
    const nonJson = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    await expect(adapterFor(nonJson).create({ env: {} }))
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: expect.stringContaining("502") });
  });
});

describe("adapter rule", () => {
  it("cloudSandbox never reads the environment: behavior comes only from constructor arguments", async () => {
    // Cloned from connections.test.ts and widened to the sandbox BYO vars, per
    // that test's instruction to lanes cloning the pattern.
    const WATCHED_ENV_PREFIXES = ["VENDO_", "E2B_", "MODAL_"];
    const reads: string[] = [];
    const realEnv = process.env;
    process.env = new Proxy({
      ...realEnv,
      VENDO_API_KEY: "vnd_env",
      VENDO_CLOUD_URL: "https://env.test",
      E2B_API_KEY: "e2b_env",
      MODAL_TOKEN_ID: "modal_env",
      MODAL_TOKEN_SECRET: "modal_env_secret",
    }, {
      get(target, property) {
        if (typeof property === "string") reads.push(property);
        return target[property as keyof typeof target];
      },
    });
    try {
      const console_ = fakeConsole();
      const adapter = cloudSandbox({
        apiKey: "vnd_arg",
        baseUrl: "https://arg.test",
        fetch: console_.handler as unknown as typeof fetch,
      });
      const machine = await adapter.create({ env: {} });
      await machine.stop();
      expect(console_.requests[0]!.url).toContain("https://arg.test/");
      expect(console_.requests[0]!.authorization).toBe("Bearer vnd_arg");
      expect(reads.filter((name) => WATCHED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))))
        .toEqual([]);
    } finally {
      process.env = realEnv;
    }
  });
});
