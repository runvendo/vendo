import { describe, expect, it, vi } from "vitest";
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import {
  sandboxAdapterConformance,
  type SandboxConformanceHarness,
} from "@vendoai/apps/adapter-conformance";
import { CLOUD_BOX_PORT, CLOUD_SANDBOX_PATH } from "./sandbox-wire.js";
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

/** The in-box app a mock machine serves on the (single) Cloud box port. */
type BoxApp = (
  request: { method: string; path: string; headers: Record<string, string>; body: Uint8Array },
  ctx: { env: Record<string, string>; allowedDomains: string[] | undefined },
) => { status: number; headers: Record<string, string>; body: Uint8Array | string };

interface MockMachine {
  env: Record<string, string>;
  /** undefined = unrestricted egress (seam + wire-contract semantics). */
  allowedDomains: string[] | undefined;
  app?: BoxApp;
  files: Map<string, Uint8Array>;
}

/** In-memory fake of the console's /api/v1/sandboxes surface, faithful to the
 * PROVISIONAL wire contract in sandbox-wire.ts — the ONE place a Cloud-side
 * correction to that contract must land alongside the adapter. */
function fakeConsole() {
  const requests: RecordedRequest[] = [];
  const machines = new Map<string, MockMachine>();
  const snapshots = new Map<string, Omit<MockMachine, "files"> & { files: Map<string, Uint8Array> }>();
  let mintedMachines = 0;
  let mintedSnapshots = 0;

  const json = (body: unknown, status = 200): Response => Response.json(body, { status });
  const notFound = (what: string): Response =>
    json({ error: { code: "not-found", message: `${what} not found.` } }, 404);

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
    if (path === CLOUD_SANDBOX_PATH && request.method === "POST") {
      const body = recorded.json as { env: Record<string, string>; template?: string; egress?: string[] };
      const id = `m_${(++mintedMachines).toString(16).padStart(24, "0")}`;
      machines.set(id, {
        env: { ...body.env },
        allowedDomains: body.egress === undefined ? undefined : [...body.egress],
        files: new Map(),
      });
      return json({ id, url: `https://${id}.m.vendo.run` }, 201);
    }
    if (path === `${CLOUD_SANDBOX_PATH}/resume` && request.method === "POST") {
      const body = recorded.json as { ref: string; egress?: string[] | null };
      const snapshot = snapshots.get(body.ref);
      if (snapshot === undefined) return notFound("Snapshot");
      const id = `m_${(++mintedMachines).toString(16).padStart(24, "0")}`;
      machines.set(id, {
        env: { ...snapshot.env },
        // Wire contract: egress absent = snapshot-time policy, null =
        // unrestricted, a list = REPLACE the snapshot's allowlist.
        allowedDomains: !("egress" in body)
          ? (snapshot.allowedDomains === undefined ? undefined : [...snapshot.allowedDomains])
          : (body.egress === null || body.egress === undefined ? undefined : [...body.egress]),
        ...(snapshot.app === undefined ? {} : { app: snapshot.app }),
        files: new Map(snapshot.files),
      });
      return json({ id, url: `https://${id}.m.vendo.run` });
    }

    const match = new RegExp(`^${CLOUD_SANDBOX_PATH}/([^/]+)(/.*)?$`).exec(path);
    if (!match) return notFound("Route");
    const key = decodeURIComponent(match[1]!);
    const rest = match[2] ?? "";

    if (request.method === "DELETE" && rest === "") {
      // The one {id} route accepts machine ids AND snapshot refs (wire contract).
      if (key.startsWith("vendo:")) {
        return snapshots.delete(key) ? json({ ok: true }) : notFound("Snapshot");
      }
      return machines.delete(key) ? json({ ok: true }) : notFound("Sandbox");
    }
    const machine = machines.get(key);
    if (machine === undefined) return notFound("Sandbox");

    switch (`${request.method} ${rest}`) {
      case "POST /request": {
        const body = recorded.json as {
          method: string; path: string; headers?: Record<string, string>; body_b64?: string;
        };
        // The relay is HARDWIRED to the box port — no port rides the wire.
        expect(recorded.json).not.toHaveProperty("port");
        if (machine.app === undefined) return json({ status: 503, headers: {}, body_b64: "" });
        const answered = machine.app(
          {
            method: body.method,
            path: body.path,
            headers: body.headers ?? {},
            body: body.body_b64 === undefined ? new Uint8Array() : fromBase64(body.body_b64),
          },
          { env: machine.env, allowedDomains: machine.allowedDomains },
        );
        return json({
          status: answered.status,
          headers: answered.headers,
          body_b64: toBase64(
            typeof answered.body === "string" ? encoder.encode(answered.body) : answered.body,
          ),
        });
      }
      case "POST /snapshot": {
        // The source machine KEEPS RUNNING — the checkpoint is what survives.
        const ref = `vendo:snap_${(++mintedSnapshots).toString(16).padStart(40, "0")}`;
        snapshots.set(ref, {
          env: { ...machine.env },
          allowedDomains: machine.allowedDomains === undefined ? undefined : [...machine.allowedDomains],
          ...(machine.app === undefined ? {} : { app: machine.app }),
          files: new Map(machine.files),
        });
        return json({ ref });
      }
      case "POST /exec":
        return json({ code: 0, stdout: "ran", stderr: "" });
      case "GET /files": {
        const bytes = machine.files.get(url.searchParams.get("path") ?? "");
        if (bytes === undefined) return notFound("File");
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
      default:
        return notFound("Route");
    }
  };

  return {
    requests,
    machines,
    snapshots,
    handler,
    installApp(machineId: string, app: BoxApp): void {
      const machine = machines.get(machineId);
      if (machine === undefined) throw new Error(`no mock machine ${machineId}`);
      machine.app = app;
    },
  };
}

const adapterFor = (
  console_: ReturnType<typeof fakeConsole>,
  baseUrl = "https://cloud.test",
): SandboxAdapter =>
  cloudSandbox({ apiKey: "vnd_secret", baseUrl, fetch: console_.handler as unknown as typeof fetch });

// ─── shared seam conformance, adapter ↔ mock console over the real wire ─────

/** The conformance app contract, in-process behind the mock relay: env from
 * the box ctx, egress simulated with the provider-faithful allowlist rule
 * (same rule as the fake sandbox harness). */
const conformanceApp: BoxApp = (request, ctx) => {
  const env = /^\/conformance\/env\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(request.path);
  if (env?.[1] !== undefined) {
    return { status: 200, headers: {}, body: ctx.env[env[1]] ?? "" };
  }
  const egress = /^\/conformance\/egress\/(.+)$/.exec(request.path);
  if (egress?.[1] !== undefined) {
    const host = decodeURIComponent(egress[1]);
    const allowed = ctx.allowedDomains === undefined || ctx.allowedDomains.some((rule) =>
      rule === host || (rule.startsWith("*.") && host.endsWith(rule.slice(1))));
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed }),
    };
  }
  if (request.method.toUpperCase() === "POST" && request.path === "/fn/echo") {
    return { status: 200, headers: {}, body: request.body };
  }
  return { status: 404, headers: {}, body: "" };
};

// One console instance across makeAdapter() calls: the suite resumes refs
// through FRESH adapter instances, which must land on the same Cloud state.
const conformanceConsole = fakeConsole();
const harness: SandboxConformanceHarness = {
  makeAdapter: () => adapterFor(conformanceConsole),
  async bootstrap(machine) {
    conformanceConsole.installApp(machine.id, conformanceApp);
  },
  enforcesAllowedDomains: true,
  // The Cloud relay is hardwired to CLOUD_BOX_PORT; its single-port behavior
  // (typed cloud-single-port error) is covered beside the adapter below.
  multiPort: false,
};
sandboxAdapterConformance("cloudSandbox (mock console)", harness);

// ─── cloud-specific wire + error behavior ────────────────────────────────────

describe("cloudSandbox", () => {
  it("speaks the documented console wire shapes exactly", async () => {
    const console_ = fakeConsole();
    const adapter = adapterFor(console_);
    const machine = await adapter.create({
      template: "vendo-box-node22",
      env: { PORT: String(CLOUD_BOX_PORT), APP: "wire" },
      allowedDomains: [],
    });
    expect(machine.id).toMatch(/^m_/);
    expect(console_.requests[0]).toMatchObject({
      method: "POST",
      url: `https://cloud.test${CLOUD_SANDBOX_PATH}`,
      json: {
        env: { PORT: String(CLOUD_BOX_PORT), APP: "wire" },
        template: "vendo-box-node22",
        egress: [],
      },
    });

    console_.installApp(machine.id, conformanceApp);
    const proxied = await machine.request({
      method: "POST",
      path: "fn/echo", // missing leading slash is normalized, e2b-adapter parity
      headers: { "x-test": "yes" },
      body: "ping",
    });
    expect(console_.requests[1]).toMatchObject({
      method: "POST",
      url: `https://cloud.test${CLOUD_SANDBOX_PATH}/${machine.id}/request`,
      json: {
        method: "POST",
        path: "/fn/echo",
        headers: { "x-test": "yes" },
        body_b64: toBase64(encoder.encode("ping")),
      },
    });
    expect(decoder.decode(proxied.body)).toBe("ping");

    const ref = await machine.snapshot();
    expect(ref).toMatch(/^vendo:snap_[0-9a-f]{40}$/);
    expect(console_.requests[2]).toMatchObject({
      method: "POST",
      url: `https://cloud.test${CLOUD_SANDBOX_PATH}/${machine.id}/snapshot`,
    });

    await machine.destroy();
    expect(console_.requests[3]).toMatchObject({
      method: "DELETE",
      url: `https://cloud.test${CLOUD_SANDBOX_PATH}/${machine.id}`,
    });

    await adapter.destroy(ref);
    expect(console_.requests[4]).toMatchObject({
      method: "DELETE",
      url: `https://cloud.test${CLOUD_SANDBOX_PATH}/${encodeURIComponent(ref)}`,
    });
    await expect(adapter.resume(ref)).rejects.toMatchObject({ code: "not-found" });
  });

  it("relays request() only to the single Cloud box port, rejecting others with the typed cloud-single-port error", async () => {
    const console_ = fakeConsole();
    const machine = await adapterFor(console_).create({ env: { HELLO: "port" } });
    console_.installApp(machine.id, conformanceApp);

    // An explicit port equal to the hardwired box port IS the default route.
    const explicit = await machine.request({
      method: "GET",
      path: "/conformance/env/HELLO",
      port: CLOUD_BOX_PORT,
    });
    expect(explicit.status).toBe(200);
    expect(decoder.decode(explicit.body)).toBe("port");

    // Any other port is a typed error BEFORE anything rides the wire — the
    // Cloud relay serves exactly one listener (e2b keeps multi-port).
    const sent = console_.requests.length;
    await expect(machine.request({ method: "GET", path: "/", port: 9090 }))
      .rejects.toMatchObject({
        name: "VendoError",
        code: "not-implemented",
        detail: { reason: "cloud-single-port", port: 9090 },
      });
    expect(console_.requests.length).toBe(sent);
  });

  it("resume rides the ref with the three-state egress override", async () => {
    const console_ = fakeConsole();
    const adapter = adapterFor(console_);
    const machine = await adapter.create({ env: {}, allowedDomains: ["example.com"] });
    const ref = await machine.snapshot();

    // Absent policy → absent egress field: the snapshot-time policy applies.
    await adapter.resume(ref);
    expect(console_.requests.at(-1)!.json).toEqual({ ref });

    // A policy with a list REPLACES the snapshot's allowlist.
    await adapter.resume(ref, { allowedDomains: ["example.org"] });
    expect(console_.requests.at(-1)!.json).toEqual({ ref, egress: ["example.org"] });

    // A policy carrying undefined means unrestricted — explicit null on the
    // wire, so "no override" and "override to unrestricted" stay distinct.
    await adapter.resume(ref, { allowedDomains: undefined });
    expect(console_.requests.at(-1)!.json).toEqual({ ref, egress: null });
  });

  it("stop() is the defensive Cloud sleep: preservation snapshot, then machine delete", async () => {
    const console_ = fakeConsole();
    const machine = await adapterFor(console_).create({ env: {} });
    await machine.stop();
    await machine.stop(); // sleeping twice shares the one transition
    const wire = console_.requests.slice(1).map((request) => `${request.method} ${new URL(request.url).pathname}`);
    expect(wire).toEqual([
      `POST ${CLOUD_SANDBOX_PATH}/${machine.id}/snapshot`,
      `DELETE ${CLOUD_SANDBOX_PATH}/${machine.id}`,
    ]);
    // destroy() after a sleep stays the seam's no-op (already-gone tolerated).
    await machine.destroy();
    await machine.destroy();
  });

  it("rejects snapshot refs from other providers before anything rides the wire", async () => {
    const console_ = fakeConsole();
    const adapter = adapterFor(console_);
    for (const foreign of ["bogus:not-a-real-ref", "e2b:v2:abc", "snap_nocolon"]) {
      await expect(adapter.resume(foreign)).rejects.toMatchObject({ code: "validation" });
      await expect(adapter.destroy(foreign)).rejects.toMatchObject({ code: "validation" });
    }
    expect(console_.requests).toEqual([]);
  });

  it("destroy(ref) treats already-gone state as the seam's no-op but propagates real failures", async () => {
    const console_ = fakeConsole();
    const adapter = adapterFor(console_);
    // Never minted: the console answers 404 → idempotent no-op by seam contract.
    await expect(adapter.destroy(`vendo:snap_${"0".repeat(40)}`)).resolves.toBeUndefined();

    const failing = cloudSandbox({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: (async () => Response.json(
        { error: { code: "unavailable", message: "Sandbox provider is unavailable." } },
        { status: 503 },
      )) as unknown as typeof fetch,
    });
    await expect(failing.destroy(`vendo:snap_${"0".repeat(40)}`))
      .rejects.toMatchObject({ code: "sandbox-unavailable" });
  });

  it("defaults the base URL to the Vendo console", async () => {
    const cloudFetch = vi.fn(async () =>
      Response.json({ id: `m_${"0".repeat(24)}`, url: "https://m.test" }, { status: 201 }));
    const adapter = cloudSandbox({ apiKey: "vnd_secret", fetch: cloudFetch as unknown as typeof fetch });
    await adapter.create({ env: {} });
    expect(cloudFetch.mock.calls[0]![0]).toBe(`https://console.vendo.run${CLOUD_SANDBOX_PATH}`);
  });

  it("carries the org key and the deployment identity on every console request", async () => {
    const console_ = fakeConsole();
    const adapter = adapterFor(console_);
    const machine = await adapter.create({ env: {} });
    const ref = await machine.snapshot();
    await machine.stop();
    await (await adapter.resume(ref)).destroy();
    await adapter.destroy(ref);
    expect(console_.requests.length).toBeGreaterThanOrEqual(6);
    for (const request of console_.requests) {
      expect(request.authorization).toBe("Bearer vnd_secret");
      expect(request.url).toContain(`https://cloud.test${CLOUD_SANDBOX_PATH}`);
      expect(request.deploymentHost).toEqual(expect.any(String));
      expect(request.deploymentHost).not.toBe("");
      expect(request.deploymentName).toEqual(expect.any(String));
      expect(request.deploymentName).not.toBe("");
    }
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
    const stubbed = (fetchImpl: unknown) =>
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
      stubbed(handleThen(garbage)).create({ env: {} });

    // Missing machine handle on create and resume.
    await expect(stubbed(vi.fn(async () => Response.json({}))).create({ env: {} }))
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: /no machine handle/ });
    await expect(stubbed(vi.fn(async () => Response.json({ id: 42, url: null }))).resume(`vendo:snap_${"a".repeat(40)}`))
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: /no machine handle/ });

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

    // A foreign snapshot ref would be stored and later refused by resume/
    // destroy — rejected at the seam instead.
    await expect((await machineFor({ ref: "e2b:v2:not-ours" })).snapshot())
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: /foreign snapshot reference/ });

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
    const stubbed = (fetchImpl: unknown) =>
      cloudSandbox({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: fetchImpl as typeof fetch });

    await expect(stubbed(respond("not-found", "Snapshot not found.", 404)).resume(`vendo:snap_${"a".repeat(40)}`))
      .rejects.toMatchObject({ code: "not-found" });
    await expect(stubbed(respond("conflict", "Sandbox is paused.", 409)).create({ env: {} }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(stubbed(respond("unavailable", "Sandbox provider is unavailable.", 503)).create({ env: {} }))
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: "Sandbox provider is unavailable." });
    const nonJson = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    await expect(stubbed(nonJson).create({ env: {} }))
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: expect.stringContaining("502") });
  });

  it("keeps the adapter-private exec/files bootstrap surface on the console wire", async () => {
    // NOT part of the public seam — the in-box agent owns the inside of the
    // box; the live conformance lane uses these to install its test app.
    const console_ = fakeConsole();
    const machine = await adapterFor(console_).create({ env: {} }) as SandboxMachine & {
      exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
      files: {
        read(path: string): Promise<Uint8Array>;
        write(path: string, bytes: Uint8Array | string): Promise<void>;
        list(dir: string): Promise<string[]>;
      };
    };
    expect(await machine.exec("pwd", { cwd: "/app", timeoutMs: 9_000 })).toMatchObject({ code: 0 });
    expect(console_.requests.at(-1)).toMatchObject({
      method: "POST",
      url: `https://cloud.test${CLOUD_SANDBOX_PATH}/${machine.id}/exec`,
      json: { cmd: "pwd", cwd: "/app", timeout_ms: 9_000 },
    });

    await machine.files.write("/app/a.bin", new Uint8Array([5, 6]));
    expect(console_.requests.at(-1)).toMatchObject({
      method: "PUT",
      url: `https://cloud.test${CLOUD_SANDBOX_PATH}/${machine.id}/files?path=%2Fapp%2Fa.bin`,
      contentType: "application/octet-stream",
      bytes: new Uint8Array([5, 6]),
    });
    expect(await machine.files.read("/app/a.bin")).toEqual(new Uint8Array([5, 6]));
    expect(await machine.files.list("/app")).toEqual(["a.bin"]);
  });
});

describe("adapter rule", () => {
  it("cloudSandbox never reads the environment: behavior comes only from constructor arguments", async () => {
    // Cloned from connections.test.ts and widened to the sandbox BYO vars, per
    // that test's instruction to lanes cloning the pattern.
    const WATCHED_ENV_PREFIXES = ["VENDO_", "E2B_"];
    const reads: string[] = [];
    const realEnv = process.env;
    process.env = new Proxy({
      ...realEnv,
      VENDO_API_KEY: "vnd_env",
      VENDO_CLOUD_URL: "https://env.test",
      E2B_API_KEY: "e2b_env",
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
      await machine.destroy();
      expect(console_.requests[0]!.url).toContain("https://arg.test/");
      expect(console_.requests[0]!.authorization).toBe("Bearer vnd_arg");
      expect(reads.filter((name) => WATCHED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))))
        .toEqual([]);
    } finally {
      process.env = realEnv;
    }
  });
});
