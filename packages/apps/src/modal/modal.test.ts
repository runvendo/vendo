import { beforeEach, describe, expect, it, vi } from "vitest";
import { modalSandbox } from "./index.js";

const sdk = vi.hoisted(() => {
  const process = {
    wait: vi.fn(async () => 3),
    stdout: { readText: vi.fn(async () => "out") },
    stderr: { readText: vi.fn(async () => "err") },
  };
  const filesystem = {
    contents: new Map<string, Uint8Array>(),
    readBytes: vi.fn(async (path: string) => filesystem.contents.get(path)?.slice() ?? new Uint8Array([1, 2])),
    writeBytes: vi.fn(async (bytes: Uint8Array, path: string) => {
      filesystem.contents.set(path, bytes.slice());
    }),
    listFiles: vi.fn(async () => [{ name: "a.txt" }, { name: "dir" }]),
  };
  const sandbox = {
    sandboxId: "sandbox_456",
    filesystem,
    exec: vi.fn(async () => process),
    tunnels: vi.fn(async () => ({ 9090: { url: "https://modal.example.test" }, 8080: { url: "https://modal-8080.example.test" } })),
    snapshotFilesystem: vi.fn(async () => ({ imageId: "image_789" })),
    terminate: vi.fn(async () => undefined),
  };
  const client = {
    apps: { fromName: vi.fn(async () => ({ appId: "app_1" })) },
    images: {
      fromRegistry: vi.fn(() => ({ imageId: "base_image" })),
      fromId: vi.fn(async (imageId: string) => ({ imageId })),
    },
    sandboxes: {
      create: vi.fn(async () => sandbox),
      fromId: vi.fn(async () => sandbox),
    },
  };
  return { process, filesystem, sandbox, client, ModalClient: vi.fn(() => client) };
});

vi.mock("modal", () => ({ ModalClient: sdk.ModalClient }));

beforeEach(() => {
  vi.clearAllMocks();
  sdk.filesystem.contents.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("modal", {
    status: 202,
    headers: { "x-provider": "modal" },
  })));
});

describe("modalSandbox", () => {
  it("maps env, the create-time encrypted port, initial files, and egress", async () => {
    const adapter = modalSandbox({
      tokenId: "id_test",
      tokenSecret: "secret_test",
      timeoutMs: 40_000,
      idleTimeoutMs: 5_000,
    });
    await adapter.create({
      env: { PORT: "9090", FEATURE: "yes" },
      egress: ["api.example.com"],
      files: { "/app/server.js": "server", "/app/data.bin": new Uint8Array([7]) },
    });

    expect(sdk.ModalClient).toHaveBeenCalledWith({ tokenId: "id_test", tokenSecret: "secret_test" });
    expect(sdk.client.apps.fromName).toHaveBeenCalledWith("vendo-apps", { createIfMissing: true });
    expect(sdk.client.images.fromRegistry).toHaveBeenCalledWith("node:22-alpine");
    expect(sdk.client.sandboxes.create).toHaveBeenCalledWith(
      { appId: "app_1" },
      { imageId: "base_image" },
      expect.objectContaining({
        env: { PORT: "9090", FEATURE: "yes" },
        command: ["sh", "-c", expect.stringContaining("/app/start.sh")],
        encryptedPorts: [9090],
        workdir: "/app",
        timeoutMs: 40_000,
        idleTimeoutMs: 5_000,
        outboundDomainAllowlist: ["api.example.com"],
      }),
    );
    expect(sdk.filesystem.writeBytes.mock.calls).toEqual(expect.arrayContaining([
      [expect.any(Uint8Array), "/app/server.js"],
      [expect.any(Uint8Array), "/app/data.bin"],
    ]));
    expect(sdk.filesystem.writeBytes.mock.calls.some(
      ([, path]) => path === "/app/.vendo-modal-state.json",
    )).toBe(false);
  });

  it("uses empty outbound-only allowlists so deny-all egress keeps tunnels reachable", async () => {
    await modalSandbox().create({ env: {}, egress: [] });
    expect(sdk.client.sandboxes.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ outboundCidrAllowlist: [], outboundDomainAllowlist: [] }),
    );
  });

  it("maps exec, filesystem argument order, tunnels, requests, snapshots, and terminate", async () => {
    const machine = await modalSandbox().create({ env: { PORT: "9090" } });
    await expect(machine.exec("pwd", { cwd: "/work", timeoutMs: 250 })).resolves.toEqual({
      code: 3,
      stdout: "out",
      stderr: "err",
    });
    expect(sdk.sandbox.exec).toHaveBeenCalledWith(["sh", "-c", "pwd"], { workdir: "/work", timeoutMs: 250 });
    await expect(machine.files.read("/app/a")).resolves.toEqual(new Uint8Array([1, 2]));
    await machine.files.write("/app/b", "beta");
    expect(sdk.filesystem.writeBytes).toHaveBeenCalledWith(expect.any(Uint8Array), "/app/b");
    await expect(machine.files.list("/app")).resolves.toEqual(["a.txt", "dir"]);

    await expect(machine.url?.(9090)).resolves.toBe("https://modal.example.test");
    await expect(machine.request({ method: "GET", path: "/health" })).resolves.toEqual({
      status: 202,
      headers: { "content-type": "text/plain;charset=UTF-8", "x-provider": "modal" },
      body: new TextEncoder().encode("modal"),
    });
    expect(fetch).toHaveBeenCalledWith("https://modal.example.test/health", expect.objectContaining({ method: "GET" }));

    await expect(machine.snapshot()).resolves.toMatch(/^modal:v1:/);
    await machine.stop();
    expect(sdk.sandbox.terminate).toHaveBeenCalledOnce();
  });

  it("restores opaque image refs with the original create policy and rejects legacy refs", async () => {
    const adapter = modalSandbox();
    const machine = await adapter.create({ env: { PORT: "9090", FEATURE: "yes" }, egress: ["api.example.com"] });
    const snapshotRef = await machine.snapshot();
    await adapter.resume(snapshotRef);
    expect(sdk.client.images.fromId).toHaveBeenCalledWith("image_789");
    expect(sdk.client.sandboxes.create).toHaveBeenLastCalledWith(
      expect.anything(),
      { imageId: "image_789" },
      expect.objectContaining({
        env: { PORT: "9090", FEATURE: "yes" },
        encryptedPorts: [9090],
        outboundDomainAllowlist: ["api.example.com"],
      }),
    );

    await expect(adapter.resume("modal:im_image_789")).rejects.toMatchObject({ code: "validation" });
    await expect(adapter.resume("modal:sb_running_1")).rejects.toMatchObject({ code: "validation" });
    await expect(adapter.resume("e2b:wrong")).rejects.toMatchObject({ code: "validation" });
    expect(sdk.client.sandboxes.fromId).not.toHaveBeenCalled();
  });

  it("restores env, egress, and port from a snapshot in a fresh adapter process", async () => {
    const firstProcess = modalSandbox();
    const machine = await firstProcess.create({
      env: { PORT: "9090", FEATURE: "durable", SECRET_HANDLE: "vendo-secret:HANDLE:nonce" },
      egress: ["api.example.com"],
    });
    const snapshotRef = await machine.snapshot();

    const freshProcess = modalSandbox();
    await freshProcess.resume(snapshotRef);

    expect(sdk.client.sandboxes.create).toHaveBeenLastCalledWith(
      expect.anything(),
      { imageId: "image_789" },
      expect.objectContaining({
        env: {
          PORT: "9090",
          FEATURE: "durable",
          SECRET_HANDLE: "vendo-secret:HANDLE:nonce",
        },
        encryptedPorts: [9090],
        outboundDomainAllowlist: ["api.example.com"],
      }),
    );
  });

  it("does not let app-writable snapshot contents weaken egress on fresh resume", async () => {
    const firstProcess = modalSandbox();
    const machine = await firstProcess.create({ env: { PORT: "9090" }, egress: [] });
    // Model the root app winning its rewrite race after the adapter's last write
    // but before Modal captures the filesystem image.
    sdk.sandbox.snapshotFilesystem.mockImplementationOnce(async () => {
      sdk.filesystem.contents.set("/app/.vendo-modal-state.json", new TextEncoder().encode(JSON.stringify({
        version: 1,
        env: { PORT: "9090" },
        port: 9090,
      })));
      return { imageId: "image_789" };
    });
    const snapshotRef = await machine.snapshot();

    await modalSandbox().resume(snapshotRef);

    expect(sdk.client.sandboxes.create).toHaveBeenLastCalledWith(
      expect.anything(),
      { imageId: "image_789" },
      expect.objectContaining({ outboundCidrAllowlist: [], outboundDomainAllowlist: [] }),
    );
  });
});
