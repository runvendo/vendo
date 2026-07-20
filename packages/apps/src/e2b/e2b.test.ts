import { beforeEach, describe, expect, it, vi } from "vitest";
import { e2bSandbox } from "./index.js";

/** The adapter-private bootstrap/diagnostics extras (not part of the seam). */
interface AdapterPrivateMachine {
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  files: {
    read(path: string): Promise<Uint8Array>;
    write(path: string, bytes: Uint8Array | string): Promise<void>;
    list(dir: string): Promise<string[]>;
  };
  url?(port: number): Promise<string>;
}

const sdk = vi.hoisted(() => {
  const sandbox = {
    sandboxId: "sandbox_123",
    getHost: vi.fn((port: number) => `${port}-sandbox_123.e2b.app`),
    createSnapshot: vi.fn(async () => ({ snapshotId: "snapshot_789" })),
    pause: vi.fn(async () => true),
    kill: vi.fn(async () => true),
    setTimeout: vi.fn(async () => undefined),
    commands: {
      run: vi.fn(async () => ({ exitCode: 7, stdout: "out", stderr: "err" })),
    },
    files: {
      read: vi.fn(async () => new Uint8Array([1, 2, 3])),
      write: vi.fn(async () => undefined),
      list: vi.fn(async () => [{ name: "a.txt" }, { name: "nested" }]),
    },
  };
  const resumedSandbox = {
    ...sandbox,
    sandboxId: "sandbox_456",
    getHost: vi.fn((port: number) => `${port}-sandbox_456.e2b.app`),
    setTimeout: vi.fn(async () => undefined),
  };
  return {
    sandbox,
    resumedSandbox,
    create: vi.fn(async (templateOrOptions?: unknown) =>
      typeof templateOrOptions === "string" && (templateOrOptions as string).startsWith("snapshot_")
        ? resumedSandbox
        : sandbox),
    connect: vi.fn(async () => sandbox),
    staticKill: vi.fn(async () => true),
    deleteSnapshot: vi.fn(async () => true),
  };
});

class FakeNotFoundError extends Error {}

vi.mock("e2b", () => ({
  ALL_TRAFFIC: "0.0.0.0/0",
  NotFoundError: FakeNotFoundError,
  Sandbox: {
    create: sdk.create,
    connect: sdk.connect,
    kill: sdk.staticKill,
    deleteSnapshot: sdk.deleteSnapshot,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([9, 8]), {
    status: 201,
    headers: { "x-provider": "e2b" },
  })));
});

describe("e2bSandbox", () => {
  const v2SnapshotRef = `e2b:v2:${Buffer.from(JSON.stringify({
    version: 2,
    snapshotId: "snapshot_789",
    sourceSandboxId: "sandbox_123",
    port: 8080,
  })).toString("base64url")}`;

  it("maps template, env, and the allowedDomains allowlist at create", async () => {
    const adapter = e2bSandbox({ apiKey: "key_test", timeoutMs: 12_345 });
    await adapter.create({
      template: "vendo-base",
      env: { PORT: "8080", FEATURE: "yes" },
      allowedDomains: ["api.example.com"],
    });

    expect(sdk.create).toHaveBeenCalledWith("vendo-base", {
      apiKey: "key_test",
      envs: { PORT: "8080", FEATURE: "yes" },
      timeoutMs: 12_345,
      network: {
        allowOut: ["api.example.com"],
        denyOut: ["0.0.0.0/0"],
      },
    });
  });

  it("uses the provider default template and unrestricted egress when unspecified", async () => {
    await e2bSandbox({ apiKey: "key_test", timeoutMs: 9_000 }).create({ env: {} });
    expect(sdk.create).toHaveBeenCalledWith({
      apiKey: "key_test",
      envs: {},
      timeoutMs: 9_000,
      allowInternetAccess: true,
    });
  });

  it("proxies requests to $PORT by default and honors an explicit port", async () => {
    const machine = await e2bSandbox({ apiKey: "key_test" }).create({ env: { PORT: "9090" } });
    await expect(machine.request({ method: "POST", path: "/fn/echo", body: new Uint8Array([7]) })).resolves.toEqual({
      status: 201,
      headers: { "x-provider": "e2b" },
      body: new Uint8Array([9, 8]),
    });
    expect(fetch).toHaveBeenLastCalledWith("https://9090-sandbox_123.e2b.app/fn/echo", expect.objectContaining({
      method: "POST",
      body: expect.any(ArrayBuffer),
    }));
    await machine.request({ method: "GET", path: "/other", port: 3000 });
    expect(fetch).toHaveBeenLastCalledWith("https://3000-sandbox_123.e2b.app/other", expect.anything());
  });

  it("extends the provider TTL on request activity so a busy box outlives timeoutMs", async () => {
    // The provider deadline is fixed at create/resume; without sliding it, a
    // machine under steady traffic is killed mid-session at timeoutMs before
    // the idle lifecycle ever snapshots it.
    const machine = await e2bSandbox({ apiKey: "key_test", timeoutMs: 12_345 }).create({ env: {} });
    await machine.request({ method: "GET", path: "/a" });
    expect(sdk.sandbox.setTimeout).toHaveBeenCalledWith(12_345);
    // Throttled: back-to-back requests share one provider extension call.
    await machine.request({ method: "GET", path: "/b" });
    expect(sdk.sandbox.setTimeout).toHaveBeenCalledOnce();

    // A resumed machine slides its deadline the same way…
    const resumed = await e2bSandbox({ apiKey: "key_test", timeoutMs: 9_000 }).resume(v2SnapshotRef);
    // …and the extension is best-effort: a provider failure never fails the request.
    sdk.resumedSandbox.setTimeout.mockRejectedValueOnce(new Error("e2b is down"));
    await expect(resumed.request({ method: "GET", path: "/c" })).resolves.toMatchObject({ status: 201 });
    expect(sdk.resumedSandbox.setTimeout).toHaveBeenCalledWith(9_000);
  });

  it("snapshots to a v2 ref, sleeps with pause, and destroys with kill", async () => {
    const machine = await e2bSandbox({ apiKey: "key_test" }).create({ env: {} });
    await expect(machine.snapshot()).resolves.toBe(v2SnapshotRef);
    expect(sdk.sandbox.createSnapshot).toHaveBeenCalledOnce();

    expect(sdk.sandbox.pause).not.toHaveBeenCalled();
    await machine.stop();
    await machine.stop(); // idempotent: the provider sees ONE pause
    expect(sdk.sandbox.pause).toHaveBeenCalledOnce();
    expect(sdk.sandbox.kill).not.toHaveBeenCalled();
    await machine.destroy();
    await machine.destroy(); // idempotent: the provider sees ONE kill
    expect(sdk.sandbox.kill).toHaveBeenCalledOnce();
    await machine.stop(); // sleeping a destroyed machine is a no-op, not a second pause
    expect(sdk.sandbox.pause).toHaveBeenCalledOnce();
  });

  it("parses only e2b refs and boots an independent machine from a snapshot", async () => {
    const adapter = e2bSandbox({ apiKey: "key_test", timeoutMs: 9_000 });
    await expect(adapter.resume("modal:im_wrong")).rejects.toMatchObject({ code: "validation" });
    await expect(adapter.resume("e2b:v2:")).rejects.toMatchObject({ code: "validation" });
    await expect(adapter.resume("e2b:")).rejects.toMatchObject({ code: "validation" });
    await expect(adapter.resume(v2SnapshotRef)).resolves.toMatchObject({ id: "sandbox_456" });
    expect(sdk.create).toHaveBeenLastCalledWith("snapshot_789", {
      apiKey: "key_test",
      timeoutMs: 9_000,
      allowInternetAccess: true,
    });
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it("still resumes refs minted by the retired v1 adapter, mapping egress to allowedDomains", async () => {
    const legacyRef = `e2b:v1:${Buffer.from(JSON.stringify({
      version: 1,
      snapshotId: "snapshot_789",
      egress: ["api.example.com"],
      port: 9090,
    })).toString("base64url")}`;
    const adapter = e2bSandbox({ apiKey: "key_test", timeoutMs: 9_000 });
    const machine = await adapter.resume(legacyRef);
    expect(sdk.create).toHaveBeenLastCalledWith("snapshot_789", {
      apiKey: "key_test",
      timeoutMs: 9_000,
      network: { allowOut: ["api.example.com"], denyOut: ["0.0.0.0/0"] },
    });
    // and the restored $PORT drives request routing
    await machine.request({ method: "GET", path: "/port" });
    expect(fetch).toHaveBeenLastCalledWith("https://9090-sandbox_456.e2b.app/port", expect.anything());
  });

  it("persists a non-default port and a denied-egress policy in the opaque snapshot ref", async () => {
    const adapter = e2bSandbox({ apiKey: "key_test", timeoutMs: 9_000 });
    const machine = await adapter.create({ env: { PORT: "9090" }, allowedDomains: [] });
    const snapshotRefWithPolicy = await machine.snapshot();
    await adapter.resume(snapshotRefWithPolicy);
    expect(sdk.create).toHaveBeenLastCalledWith("snapshot_789", {
      apiKey: "key_test",
      timeoutMs: 9_000,
      network: { allowOut: [], denyOut: ["0.0.0.0/0"] },
    });
  });

  it("destroys a sleeping machine by ref: reaps the paused source and deletes the snapshot", async () => {
    const adapter = e2bSandbox({ apiKey: "key_test" });
    await adapter.destroy(v2SnapshotRef);
    expect(sdk.staticKill).toHaveBeenCalledWith("sandbox_123", { apiKey: "key_test" });
    expect(sdk.deleteSnapshot).toHaveBeenCalledWith("snapshot_789", { apiKey: "key_test" });
    expect(sdk.create).not.toHaveBeenCalled(); // never resumes to destroy

    // idempotent: already-deleted provider state is a no-op…
    sdk.deleteSnapshot.mockRejectedValueOnce(new FakeNotFoundError("gone"));
    sdk.staticKill.mockRejectedValueOnce(new Error("already dead"));
    await expect(adapter.destroy(v2SnapshotRef)).resolves.toBeUndefined();
    // …but a real provider failure still surfaces
    sdk.deleteSnapshot.mockRejectedValueOnce(new Error("e2b is down"));
    await expect(adapter.destroy(v2SnapshotRef)).rejects.toThrow("e2b is down");
    await expect(adapter.destroy("modal:im_wrong")).rejects.toMatchObject({ code: "validation" });
    // an empty recorded source id is a malformed ref, not a swallowed kill("")
    const emptySourceRef = `e2b:v2:${Buffer.from(JSON.stringify({
      version: 2,
      snapshotId: "snapshot_789",
      sourceSandboxId: "",
      port: 8080,
    })).toString("base64url")}`;
    await expect(adapter.destroy(emptySourceRef)).rejects.toMatchObject({ code: "validation" });
  });

  it("destroys a retired v1 ref by snapshot deletion alone (no recorded source sandbox)", async () => {
    const legacyRef = `e2b:v1:${Buffer.from(JSON.stringify({
      version: 1,
      snapshotId: "snapshot_789",
      port: 8080,
    })).toString("base64url")}`;
    await e2bSandbox({ apiKey: "key_test" }).destroy(legacyRef);
    expect(sdk.staticKill).not.toHaveBeenCalled();
    expect(sdk.deleteSnapshot).toHaveBeenCalledWith("snapshot_789", { apiKey: "key_test" });
  });

  it("serves the sandbox public host as the seam machine URL (Wave 4 layer 3)", async () => {
    const adapter = e2bSandbox({ apiKey: "key_test" });
    const machine = await adapter.create({ env: { PORT: "8080" } });
    // No-arg url() targets the app's $PORT — the browser→box serving path.
    await expect(machine.url()).resolves.toBe("https://8080-sandbox_123.e2b.app");
    await expect(machine.url(9090)).resolves.toBe("https://9090-sandbox_123.e2b.app");
  });

  it("keeps adapter-private exec and files", async () => {
    const adapter = e2bSandbox({ apiKey: "key_test", timeoutMs: 5_000 });
    const created = await adapter.create({
      env: { PORT: "8080" },
      allowedDomains: ["api.example.com"],
    });
    const machine = created as unknown as AdapterPrivateMachine;
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({
      network: { allowOut: ["api.example.com"], denyOut: ["0.0.0.0/0"] },
    }));

    await expect(machine.exec("pwd", { cwd: "/app", timeoutMs: 200 })).resolves.toEqual({
      code: 7,
      stdout: "out",
      stderr: "err",
    });
    expect(sdk.sandbox.commands.run).toHaveBeenCalledWith("pwd", { cwd: "/app", timeoutMs: 200 });
    sdk.sandbox.commands.run.mockRejectedValueOnce({ exitCode: 23, stdout: "partial", stderr: "failed" });
    await expect(machine.exec("false")).resolves.toEqual({ code: 23, stdout: "partial", stderr: "failed" });
    await expect(machine.files.read("/app/a")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(sdk.sandbox.files.read).toHaveBeenCalledWith("/app/a", { format: "bytes" });
    await machine.files.write("/app/b", new Uint8Array([6]));
    expect(sdk.sandbox.files.write).toHaveBeenLastCalledWith("/app/b", expect.any(ArrayBuffer));
    await expect(machine.files.list("/app")).resolves.toEqual(["a.txt", "nested"]);
    await expect(machine.url?.(8080)).resolves.toBe("https://8080-sandbox_123.e2b.app");

    // v2 seam semantics: stop() is the snapshot-preserving pause, destroy() kills.
    await created.stop();
    expect(sdk.sandbox.pause).toHaveBeenCalledOnce();
    expect(sdk.sandbox.kill).not.toHaveBeenCalled();
    await created.destroy();
    expect(sdk.sandbox.kill).toHaveBeenCalledOnce();
  });
});
