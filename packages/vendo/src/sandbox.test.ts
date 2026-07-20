import { describe, expect, it, vi } from "vitest";
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import {
  sandboxAdapterConformance,
  type SandboxConformanceHarness,
} from "@vendoai/apps/adapter-conformance";
import { CLOUD_BOX_PORT, CLOUD_SANDBOX_PATH, CLOUD_SNAPSHOT_REF_PREFIX } from "./sandbox-wire.js";
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

/** The in-box app a mock machine serves on its $PORT. */
type BoxApp = (
  request: { method: string; path: string; headers: Record<string, string>; body: Uint8Array },
  ctx: { env: Record<string, string>; allowedDomains: string[] | undefined },
) => { status: number; headers: Record<string, string>; body: Uint8Array | string };

interface MockMachine {
  /** Artifact model (Cloud ship note 2026-07-19): snapshots are persistent
   * artifacts, the source keeps running; DELETE stops the machine but its
   * artifacts survive. */
  state: "live" | "stopped";
  env: Record<string, string>;
  /** undefined = unrestricted egress (seam + wire-contract semantics). */
  allowedDomains: string[] | undefined;
  app?: BoxApp;
  files: Map<string, Uint8Array>;
}

/** What an artifact snapshots: the box state a resume boots a NEW machine
 * from. Network config is NOT part of it — resume states egress explicitly. */
interface MockSnapshot {
  env: Record<string, string>;
  app?: BoxApp;
  files: Map<string, Uint8Array>;
}

/** In-memory fake of the console's /api/v1/sandboxes surface, faithful to the
 * wire contract in sandbox-wire.ts (artifact model, verified live) — the ONE
 * place a Cloud-side change must land alongside the adapter. */
function fakeConsole() {
  const requests: RecordedRequest[] = [];
  const machines = new Map<string, MockMachine>();
  const snapshots = new Map<string, MockSnapshot>();
  let mintedMachines = 0;
  let mintedSnapshots = 0;

  const json = (body: unknown, status = 200): Response => Response.json(body, { status });
  const conflict = (state: string): Response =>
    json({ error: { code: "conflict", message: `Sandbox is ${state}.` } }, 409);
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
      const body = recorded.json as { env: Record<string, string>; egress?: string[] };
      const id = `m_${(++mintedMachines).toString(36).padStart(24, "0")}`;
      machines.set(id, {
        state: "live",
        env: { ...body.env },
        allowedDomains: body.egress === undefined ? undefined : [...body.egress],
        files: new Map(),
      });
      return json({ id, url: `https://${id}.m.vendo.run` }, 201);
    }
    if (path === `${CLOUD_SANDBOX_PATH}/resume` && request.method === "POST") {
      const body = recorded.json as { ref: string; egress?: string[] };
      // Artifact model: resume boots a NEW machine from the artifact (fork
      // when the source lives, wake when it is gone) and inherits NO network
      // config — egress absent = unrestricted.
      const snapshot = snapshots.get(body.ref);
      if (snapshot === undefined) return notFound("Snapshot");
      const id = `m_${(++mintedMachines).toString(36).padStart(24, "0")}`;
      machines.set(id, {
        state: "live",
        env: { ...snapshot.env },
        allowedDomains: body.egress === undefined ? undefined : [...body.egress],
        ...(snapshot.app === undefined ? {} : { app: snapshot.app }),
        files: new Map(snapshot.files),
      });
      return json({ id, url: `https://${id}.m.vendo.run` });
    }
    const gc = new RegExp(`^${CLOUD_SANDBOX_PATH}/snapshots/([^/]+)$`).exec(path);
    if (gc && request.method === "DELETE") {
      // Artifact GC: 200 on reclaim, 404 = already gone.
      return snapshots.delete(decodeURIComponent(gc[1]!)) ? json({ ok: true }) : notFound("Snapshot");
    }

    const match = new RegExp(`^${CLOUD_SANDBOX_PATH}/([^/]+)(/.*)?$`).exec(path);
    if (!match) return notFound("Route");
    const key = decodeURIComponent(match[1]!);
    const rest = match[2] ?? "";

    if (request.method === "DELETE" && rest === "") {
      // MACHINE ids only (a ref answers 404); repeat-delete = 200; snapshot
      // artifacts SURVIVE the machine.
      const machine = machines.get(key);
      if (machine === undefined) return notFound("Sandbox");
      machine.state = "stopped";
      return json({ ok: true });
    }
    const machine = machines.get(key);
    if (machine === undefined) return notFound("Sandbox");

    switch (`${request.method} ${rest}`) {
      case "POST /request": {
        if (machine.state !== "live") return conflict(machine.state);
        const body = recorded.json as {
          method: string; path: string; port?: number; headers?: Record<string, string>; body_b64?: string;
        };
        if (body.port !== undefined
          && (!Number.isInteger(body.port) || body.port < 1 || body.port > 65_535)) {
          return json({ error: { code: "validation", message: "port must be an integer between 1 and 65535." } }, 400);
        }
        // Probed: the relay targets the canonical box port when none rides
        // the wire; a port nobody listens on answers a relayed 502.
        const target = body.port ?? CLOUD_BOX_PORT;
        const appPort = Number(machine.env.PORT ?? CLOUD_BOX_PORT);
        if (machine.app === undefined || target !== appPort) {
          return json({ status: 502, headers: {}, body_b64: toBase64(encoder.encode("error code: 502")) });
        }
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
        // Artifact model: mint a persistent artifact; the source keeps
        // running (a stopped machine has nothing left to checkpoint).
        if (machine.state === "stopped") return conflict("stopped");
        const ref = `vendo:snap_${(++mintedSnapshots).toString(16).padStart(40, "0")}`;
        snapshots.set(ref, {
          env: { ...machine.env },
          ...(machine.app === undefined ? {} : { app: machine.app }),
          files: new Map(machine.files),
        });
        return json({ ref });
      }
      case "POST /exec":
        if (machine.state !== "live") return conflict(machine.state);
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

/** Wire trace as "METHOD /path" lines, base and prefix stripped. */
const wireOf = (console_: ReturnType<typeof fakeConsole>): string[] =>
  console_.requests.map((sent) => `${sent.method} ${new URL(sent.url).pathname.slice(CLOUD_SANDBOX_PATH.length)}`);

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
  // The Cloud relay defaults to the canonical box port, not $PORT; explicit
  // ports route fine and are covered beside the adapter below.
  multiPort: false,
  // Artifact model: resume boots an independent machine per call, and the
  // adapter states the allowlist (recorded or replaced) on every resume.
  resumeForks: true,
  resumeReplacesPolicy: true,
  // TEMPORARY (2026-07-20): *.m.vendo.run TLS pending the advanced
  // certificate — url() refuses loudly (CLOUD_INGRESS_TLS_BROKEN, sandbox.ts).
  ingressUnavailable: true,
};
sandboxAdapterConformance("cloudSandbox (mock console)", harness);

// ─── cloud-specific wire + error behavior ────────────────────────────────────

describe("cloudSandbox", () => {
  it("speaks the probed console wire shapes exactly", async () => {
    const console_ = fakeConsole();
    const adapter = adapterFor(console_);
    const machine = await adapter.create({
      template: "ignored-on-cloud", // dropped from the wire: the base image is Cloud's own
      env: { PORT: String(CLOUD_BOX_PORT), APP: "wire" },
      allowedDomains: [],
    });
    expect(machine.id).toMatch(/^m_/);
    expect(console_.requests[0]).toMatchObject({
      method: "POST",
      url: `https://cloud.test${CLOUD_SANDBOX_PATH}`,
      json: {
        env: { PORT: String(CLOUD_BOX_PORT), APP: "wire" },
        egress: [],
      },
    });
    expect(console_.requests[0]!.json).not.toHaveProperty("template");

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
    expect(console_.requests[1]!.json).not.toHaveProperty("port");
    expect(decoder.decode(proxied.body)).toBe("ping");

    // snapshot mints the artifact and wraps it in OUR composite ref; the
    // source keeps running (no other wire call).
    const ref = await machine.snapshot();
    expect(ref.startsWith(CLOUD_SNAPSHOT_REF_PREFIX)).toBe(true);
    expect(ref).toMatch(/^[A-Za-z][A-Za-z0-9_-]*:.+/);
    expect(wireOf(console_).slice(2)).toEqual([`POST /${machine.id}/snapshot`]);
    const still = await machine.request({ method: "POST", path: "/fn/echo", body: "alive" });
    expect(decoder.decode(still.body)).toBe("alive");

    await machine.destroy();
    expect(wireOf(console_).at(-1)).toBe(`DELETE /${machine.id}`);

    // destroy-by-ref reaps the recorded source machine, then GCs the artifact.
    await adapter.destroy(ref);
    expect(wireOf(console_).slice(-2)).toEqual([
      `DELETE /${machine.id}`,
      expect.stringMatching(/^DELETE \/snapshots\/vendo%3Asnap_[0-9a-f]{40}$/),
    ]);
    await expect(adapter.resume(ref)).rejects.toMatchObject({ code: "not-found" });
  });

  it("relays explicit ports as-is — the in-box agent control port works", async () => {
    const console_ = fakeConsole();
    const machine = await adapterFor(console_).create({ env: { PORT: "8811", HELLO: "port" } });
    console_.installApp(machine.id, conformanceApp);

    // The control-port case (BOX_CONTROL_PORT rides the wire verbatim).
    const control = await machine.request({
      method: "GET",
      path: "/conformance/env/HELLO",
      port: 8811,
    });
    expect(control.status).toBe(200);
    expect(decoder.decode(control.body)).toBe("port");
    expect(console_.requests.at(-1)!.json).toMatchObject({ port: 8811 });

    // No port on the wire → the relay's canonical default (8080) — which this
    // box does not serve, so the relay answers its 502 (probed behavior).
    const defaulted = await machine.request({ method: "GET", path: "/conformance/env/HELLO" });
    expect(defaulted.status).toBe(502);
    expect(console_.requests.at(-1)!.json).not.toHaveProperty("port");

    // The console's own port validation surfaces as the caller's fault.
    await expect(machine.request({ method: "GET", path: "/", port: 70_000 }))
      .rejects.toMatchObject({ code: "validation" });
  });

  it("url() fails loudly while *.m.vendo.run TLS is broken instead of handing out a dead URL", async () => {
    // TEMPORARY GUARD (2026-07-20, flagged decision): prod TLS for
    // *.m.vendo.run fails entirely (Cloudflare Universal SSL covers one
    // label), so every ingress URL this adapter could mint is dead. Until the
    // advanced certificate lands, url() refuses with a VendoError naming the
    // limitation — the 2→3 flip surfaces the real problem instead of shipping
    // an app whose surface cannot load.
    const console_ = fakeConsole();
    const adapter = adapterFor(console_);
    const canonical = await adapter.create({ env: { PORT: "8080" } });
    await expect(canonical.url()).rejects.toMatchObject({ code: "sandbox-unavailable" });
    await expect(canonical.url(9090)).rejects.toThrow(/\*\.m\.vendo\.run/);
  });

  // Re-enable when the *.m.vendo.run advanced certificate lands and the
  // CLOUD_INGRESS_TLS_BROKEN guard in sandbox.ts is removed.
  it.skip("url() defaults to the app's $PORT and prefixes non-canonical ports onto the ingress host", async () => {
    const console_ = fakeConsole();
    const adapter = adapterFor(console_);
    const canonical = await adapter.create({ env: { PORT: "8080" } });
    expect(await canonical.url()).toBe(`https://${canonical.id}.m.vendo.run`);
    expect(await canonical.url(9090)).toBe(`https://9090-${canonical.id}.m.vendo.run`);

    // An app listening elsewhere gets its OWN port surface by default, and
    // the $PORT rides refs so a resumed machine keeps it.
    const ported = await adapter.create({ env: { PORT: "9090" } });
    expect(await ported.url()).toBe(`https://9090-${ported.id}.m.vendo.run`);
    const woken = await adapter.resume(await ported.snapshot());
    expect(await woken.url()).toBe(`https://9090-${woken.id}.m.vendo.run`);
  });

  it("states the applicable allowlist explicitly on every resume — the wire inherits nothing", async () => {
    const console_ = fakeConsole();
    const adapter = adapterFor(console_);
    const machine = await adapter.create({ env: {}, allowedDomains: ["example.com", "api.example.com"] });
    const ref = await machine.snapshot();
    await machine.stop();

    // A bare resume re-applies the ref-recorded snapshot-time policy.
    const woken = await adapter.resume(ref);
    expect(woken.id).not.toBe(machine.id);
    expect(console_.requests.at(-1)!.json).toEqual({
      ref: expect.stringMatching(/^vendo:snap_[0-9a-f]{40}$/),
      egress: ["example.com", "api.example.com"],
    });

    // A policy REPLACES it (Lane E), and undefined means unrestricted —
    // the egress field stays off the wire entirely.
    await adapter.resume(ref, { allowedDomains: ["example.org"] });
    expect(console_.requests.at(-1)!.json).toMatchObject({ egress: ["example.org"] });
    await adapter.resume(ref, { allowedDomains: undefined });
    expect(console_.requests.at(-1)!.json).not.toHaveProperty("egress");
  });

  it("stop() destroys the machine; refs minted before it still wake a fresh one", async () => {
    const console_ = fakeConsole();
    const adapter = adapterFor(console_);
    const machine = await adapter.create({ env: {} });
    const ref = await machine.snapshot();
    await machine.stop();
    await machine.stop(); // sleeping twice shares the one transition
    expect(wireOf(console_).slice(1)).toEqual([
      `POST /${machine.id}/snapshot`,
      `DELETE /${machine.id}`,
    ]);
    // A checkpoint through the slept machine object is a caller bug.
    await expect(machine.snapshot()).rejects.toMatchObject({ code: "conflict" });
    const woken = await adapter.resume(ref);
    expect(woken.id).not.toBe(machine.id);
    // destroy() after a sleep stays the seam's no-op chain (repeat tolerated).
    await machine.destroy();
    await machine.destroy();
  });

  it("records the create-time policy in refs, immune to caller-side array mutation", async () => {
    const console_ = fakeConsole();
    const adapter = adapterFor(console_);
    const domains = ["example.com"];
    const machine = await adapter.create({ env: {}, allowedDomains: domains });
    domains.push("attacker.example"); // the caller's array is theirs to mutate
    const ref = await machine.snapshot();
    await machine.stop();
    // The bare resume re-applies what the machine was CREATED with.
    await adapter.resume(ref);
    expect(console_.requests.at(-1)!.json).toMatchObject({ egress: ["example.com"] });
  });

  it("rejects snapshot refs it did not mint before anything rides the wire", async () => {
    const console_ = fakeConsole();
    const adapter = adapterFor(console_);
    for (const foreign of [
      "bogus:not-a-real-ref",
      "e2b:v2:abc",
      "snap_nocolon",
      `vendo:snap_${"a".repeat(40)}`, // a bare console ref is not a seam ref
      "vendo:v2:", // bare prefix
      "vendo:v2:!!!not-base64url!!!", // garbage payload
      `vendo:v2:${btoa(JSON.stringify({ version: 2, machineId: "", ref: "vendo:snap_x" }))}`, // empty machine id
    ]) {
      await expect(adapter.resume(foreign)).rejects.toMatchObject({ code: "validation" });
      await expect(adapter.destroy(foreign)).rejects.toMatchObject({ code: "validation" });
    }
    expect(console_.requests).toEqual([]);
  });

  it("destroy(ref) treats already-gone state as the seam's no-op but propagates real GC failures", async () => {
    const console_ = fakeConsole();
    const adapter = adapterFor(console_);
    const machine = await adapter.create({ env: {} });
    const ref = await machine.snapshot();
    await adapter.destroy(ref);
    await adapter.destroy(ref); // artifact already GC'd (404) — no-op
    await expect(adapter.resume(ref)).rejects.toMatchObject({ code: "not-found" });

    const failing = cloudSandbox({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: (async () => Response.json(
        { error: { code: "unavailable", message: "Sandbox provider is unavailable." } },
        { status: 503 },
      )) as unknown as typeof fetch,
    });
    // The best-effort source reap swallows its failure; the artifact GC does not.
    await expect(failing.destroy(ref)).rejects.toMatchObject({ code: "sandbox-unavailable" });
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
    expect(console_.requests.length).toBeGreaterThanOrEqual(7);
    for (const request of console_.requests) {
      expect(request.authorization).toBe("Bearer vnd_secret");
      expect(request.url).toContain(`https://cloud.test${CLOUD_SANDBOX_PATH}`);
      expect(request.deploymentHost).toEqual(expect.any(String));
      expect(request.deploymentHost).not.toBe("");
      expect(request.deploymentName).toEqual(expect.any(String));
      expect(request.deploymentName).not.toBe("");
    }
  });

  it("maps an exhausted meter to the binding cloud-required error on create and resume", async () => {
    const exhausted = vi.fn(async () => Response.json(
      { error: { code: "quota-exhausted", message: "Sandbox minutes quota exhausted.", meter: "sandbox_minutes" } },
      { status: 402 },
    ));
    const adapter = cloudSandbox({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: exhausted as unknown as typeof fetch });
    await expect(adapter.create({ env: {} })).rejects.toMatchObject({
      code: "cloud-required",
      message: "Sandbox minutes quota exhausted.",
    });
    const workable = fakeConsole();
    const ref = await (await adapterFor(workable).create({ env: {} })).snapshot();
    await expect(cloudSandbox({ apiKey: "vnd_secret", baseUrl: "https://cloud.test", fetch: exhausted as unknown as typeof fetch }).resume(ref))
      .rejects.toMatchObject({ code: "cloud-required" });
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

    // Missing machine handle on create.
    await expect(stubbed(vi.fn(async () => Response.json({}))).create({ env: {} }))
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: /no machine handle/ });

    // Invalid proxy response (no body_b64).
    await expect((await machineFor({ status: 200, headers: {} })).request({ method: "GET", path: "/" }))
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: /invalid proxy response/ });

    // Well-shaped proxy response carrying invalid base64.
    await expect(
      (await machineFor({ status: 200, headers: {}, body_b64: "!!not-base64!!" })).request({ method: "GET", path: "/" }),
    ).rejects.toMatchObject({ code: "sandbox-unavailable", message: /invalid base64/ });

    // Missing snapshot ref — the pause never happened, nothing to revive.
    await expect((await machineFor({})).snapshot())
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: /no snapshot reference/ });

    // A foreign or bare-prefix console ref would mint a composite ref this
    // adapter later refuses — rejected at the seam instead.
    await expect((await machineFor({ ref: "snap-without-prefix" })).snapshot())
      .rejects.toMatchObject({ code: "sandbox-unavailable", message: /foreign snapshot reference/ });
    await expect((await machineFor({ ref: "vendo:" })).snapshot())
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
    const workable = fakeConsole();
    const ref = await (await adapterFor(workable).create({ env: {} })).snapshot();

    await expect(stubbed(respond("not-found", "Snapshot not found.", 404)).resume(ref))
      .rejects.toMatchObject({ code: "not-found" });
    await expect(stubbed(respond("conflict", "Sandbox is live.", 409)).resume(ref))
      .rejects.toMatchObject({ code: "conflict", message: "Sandbox is live." });
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
