import { beforeEach, describe, expect, it, vi } from "vitest";
import { toV1SandboxAdapter } from "../sandbox-v1-compat.js";
import { e2bSandbox } from "./index.js";

const sdk = vi.hoisted(() => {
  const sandbox = {
    sandboxId: "sandbox_123",
    getHost: vi.fn((port: number) => `${port}-sandbox_123.e2b.app`),
    createSnapshot: vi.fn(async () => ({ snapshotId: "snapshot_789" })),
    pause: vi.fn(async () => true),
    kill: vi.fn(async () => true),
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
  };
  return {
    sandbox,
    resumedSandbox,
    create: vi.fn(async (templateOrOptions?: unknown) =>
      typeof templateOrOptions === "string" && (templateOrOptions as string).startsWith("snapshot_")
        ? resumedSandbox
        : sandbox),
    connect: vi.fn(async () => sandbox),
  };
});

vi.mock("e2b", () => ({
  ALL_TRAFFIC: "0.0.0.0/0",
  Sandbox: { create: sdk.create, connect: sdk.connect },
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

  it("snapshots to a v2 ref, sleeps with pause, and destroys with kill", async () => {
    const machine = await e2bSandbox({ apiKey: "key_test" }).create({ env: {} });
    await expect(machine.snapshot()).resolves.toBe(v2SnapshotRef);
    expect(sdk.sandbox.createSnapshot).toHaveBeenCalledOnce();

    expect(sdk.sandbox.pause).not.toHaveBeenCalled();
    await machine.stop();
    expect(sdk.sandbox.pause).toHaveBeenCalledOnce();
    expect(sdk.sandbox.kill).not.toHaveBeenCalled();
    await machine.destroy();
    expect(sdk.sandbox.kill).toHaveBeenCalledOnce();
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

  it("keeps adapter-private exec, files, url, and v1 create extras for the compat bridge", async () => {
    const adapter = toV1SandboxAdapter(e2bSandbox({ apiKey: "key_test", timeoutMs: 5_000 }));
    const machine = await adapter.create({
      env: { PORT: "8080" },
      files: { "/app/a.txt": "alpha", "/app/b.bin": new Uint8Array([4, 5]) },
      egress: ["api.example.com"],
    });
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({
      network: { allowOut: ["api.example.com"], denyOut: ["0.0.0.0/0"] },
    }));
    const batch = sdk.sandbox.files.write.mock.calls[0]?.[0];
    expect(batch).toEqual([
      { path: "/app/a.txt", data: "alpha" },
      { path: "/app/b.bin", data: expect.any(ArrayBuffer) },
    ]);

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

    // v1 stop meant teardown: the bridge maps it to destroy, never pause.
    await machine.stop();
    expect(sdk.sandbox.kill).toHaveBeenCalledOnce();
    expect(sdk.sandbox.pause).not.toHaveBeenCalled();
  });
});
