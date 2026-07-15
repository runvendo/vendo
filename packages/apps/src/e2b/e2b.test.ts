import { beforeEach, describe, expect, it, vi } from "vitest";
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
      typeof templateOrOptions === "string" ? resumedSandbox : sandbox),
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
  const snapshotRef = `e2b:v1:${Buffer.from(JSON.stringify({
    version: 1,
    snapshotId: "snapshot_789",
    port: 8080,
  })).toString("base64url")}`;

  it("maps env, initial files, and provider-native egress at create", async () => {
    const adapter = e2bSandbox({ apiKey: "key_test", timeoutMs: 12_345 });
    await adapter.create({
      env: { PORT: "8080", FEATURE: "yes" },
      egress: ["api.example.com"],
      files: { "/app/a.txt": "alpha", "/app/b.bin": new Uint8Array([4, 5]) },
    });

    expect(sdk.create).toHaveBeenCalledWith({
      apiKey: "key_test",
      envs: { PORT: "8080", FEATURE: "yes" },
      timeoutMs: 12_345,
      network: {
        allowOut: ["api.example.com"],
        denyOut: ["0.0.0.0/0"],
      },
    });
    const batch = sdk.sandbox.files.write.mock.calls[0]?.[0];
    expect(batch).toEqual([
      { path: "/app/a.txt", data: "alpha" },
      { path: "/app/b.bin", data: expect.any(ArrayBuffer) },
    ]);
  });

  it("maps commands, files, URL requests, copyable snapshots, and kill", async () => {
    const machine = await e2bSandbox({ apiKey: "key_test", timeoutMs: 5_000 }).create({ env: {} });

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
    await expect(machine.request({ method: "POST", path: "/fn/echo", body: new Uint8Array([7]) })).resolves.toEqual({
      status: 201,
      headers: { "x-provider": "e2b" },
      body: new Uint8Array([9, 8]),
    });
    expect(fetch).toHaveBeenCalledWith("https://8080-sandbox_123.e2b.app/fn/echo", expect.objectContaining({
      method: "POST",
      body: expect.any(ArrayBuffer),
    }));

    await expect(machine.snapshot()).resolves.toBe(snapshotRef);
    expect(sdk.sandbox.createSnapshot).toHaveBeenCalledOnce();
    expect(sdk.sandbox.pause).not.toHaveBeenCalled();
    await machine.stop();
    expect(sdk.sandbox.kill).toHaveBeenCalledOnce();
  });

  it("parses only e2b refs, creates an independent machine from a snapshot, and leaves undefined egress unrestricted", async () => {
    const adapter = e2bSandbox({ apiKey: "key_test", timeoutMs: 9_000 });
    await adapter.create({ env: {} });
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ allowInternetAccess: true }));

    await expect(adapter.resume("modal:im_wrong")).rejects.toMatchObject({ code: "validation" });
    await expect(adapter.resume("e2b:")).rejects.toMatchObject({ code: "validation" });
    await expect(adapter.resume(snapshotRef)).resolves.toMatchObject({ id: "sandbox_456" });
    expect(sdk.create).toHaveBeenLastCalledWith("snapshot_789", {
      apiKey: "key_test",
      timeoutMs: 9_000,
      allowInternetAccess: true,
    });
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it("persists a non-default port and denied egress in the opaque snapshot ref", async () => {
    const adapter = e2bSandbox({ apiKey: "key_test", timeoutMs: 9_000 });
    const machine = await adapter.create({ env: { PORT: "9090" }, egress: [] });
    await machine.request({ method: "GET", path: "/port" });
    expect(fetch).toHaveBeenLastCalledWith("https://9090-sandbox_123.e2b.app/port", expect.anything());

    const snapshotRefWithPolicy = await machine.snapshot();
    await adapter.resume(snapshotRefWithPolicy);
    expect(sdk.create).toHaveBeenLastCalledWith("snapshot_789", {
      apiKey: "key_test",
      timeoutMs: 9_000,
      network: { allowOut: [], denyOut: ["0.0.0.0/0"] },
    });
  });
});
