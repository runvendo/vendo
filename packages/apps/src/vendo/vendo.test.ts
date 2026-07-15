import { VendoError } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vendoSandbox } from "./index.js";

const apiKey = `vnd_${"0".repeat(40)}`;

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("vendoSandbox", () => {
  it("uses bearer auth and base64-encodes initial files", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      id: "m_123456789012345678901234",
      url: "https://m_123456789012345678901234.m.vendo.run",
    }));
    vi.stubGlobal("fetch", fetcher);

    const machine = await vendoSandbox({
      apiKey,
      baseUrl: "https://broker.example.test///",
      timeoutMs: 12_345,
    }).create({
      env: { PORT: "8080", FEATURE: "yes" },
      egress: [],
      files: {
        "/app/text.txt": "hello",
        "/app/binary.bin": new Uint8Array([0, 127, 255]),
      },
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://broker.example.test/api/v1/sandboxes",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    const init = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      env: { PORT: "8080", FEATURE: "yes" },
      files: {
        "/app/text.txt": Buffer.from("hello").toString("base64"),
        "/app/binary.bin": Buffer.from([0, 127, 255]).toString("base64"),
      },
      egress: [],
    });
    await expect(machine.url?.(80)).resolves.toBe("https://m_123456789012345678901234.m.vendo.run");
    await expect(machine.url?.(65_535)).resolves.toBe("https://m_123456789012345678901234.m.vendo.run");
  });

  it("maps exec, files, requests, snapshots, screenshots, and stop", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      const parsed = new URL(url);
      const method = init.method ?? "GET";
      if (parsed.pathname === "/api/v1/sandboxes" && method === "POST") {
        return jsonResponse({ id: "m_test", url: "https://m_test.m.vendo.run" });
      }
      if (parsed.pathname.endsWith("/exec")) {
        return jsonResponse({ code: 7, stdout: "out", stderr: "err" });
      }
      if (parsed.pathname.endsWith("/files") && method === "GET") {
        return new Response(new Uint8Array([1, 2, 255]));
      }
      if (parsed.pathname.endsWith("/files") && method === "PUT") {
        return jsonResponse({ ok: true });
      }
      if (parsed.pathname.endsWith("/files/list")) {
        return jsonResponse({ entries: ["a.txt", "nested"] });
      }
      if (parsed.pathname.endsWith("/request")) {
        return jsonResponse({
          status: 201,
          headers: { "x-machine": "vendo" },
          body_b64: Buffer.from([9, 8, 7]).toString("base64"),
        });
      }
      if (parsed.pathname.endsWith("/snapshot")) {
        return jsonResponse({ ref: "vendo:snap_123" });
      }
      if (parsed.pathname.endsWith("/screenshot")) {
        return new Response(new Uint8Array([137, 80, 78, 71]));
      }
      if (parsed.pathname.endsWith("/sandboxes/m_test") && method === "DELETE") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: { code: "not-found", message: "unhandled test route" } }, 404);
    });
    vi.stubGlobal("fetch", fetcher);

    const machine = await vendoSandbox({ apiKey, baseUrl: "https://broker.example.test" })
      .create({ env: {} });

    await expect(machine.exec("pwd", { cwd: "/app", timeoutMs: 250 })).resolves.toEqual({
      code: 7,
      stdout: "out",
      stderr: "err",
    });
    await expect(machine.files.read("/app/a b.bin")).resolves.toEqual(new Uint8Array([1, 2, 255]));
    await machine.files.write("/app/write.bin", new Uint8Array([4, 5, 255]));
    await expect(machine.files.list("/app/nested dir")).resolves.toEqual(["a.txt", "nested"]);
    await expect(machine.request({
      method: "POST",
      path: "/fn/echo",
      headers: { "x-input": "yes" },
      body: new Uint8Array([6, 7, 255]),
    })).resolves.toEqual({
      status: 201,
      headers: { "x-machine": "vendo" },
      body: new Uint8Array([9, 8, 7]),
    });
    await expect(machine.snapshot()).resolves.toBe("vendo:snap_123");
    await expect(machine.screenshot?.()).resolves.toEqual(new Uint8Array([137, 80, 78, 71]));
    await machine.stop();

    const execCall = calls.find(({ url }) => url.endsWith("/exec"));
    expect(JSON.parse(String(execCall?.init.body))).toEqual({ cmd: "pwd", cwd: "/app", timeout_ms: 250 });
    expect(calls.find(({ url }) => url.includes("/files?"))?.url)
      .toContain("path=%2Fapp%2Fa+b.bin");
    const writeCall = calls.find(({ url, init }) => url.includes("write.bin") && init.method === "PUT");
    expect(new Uint8Array(writeCall?.init.body as ArrayBuffer)).toEqual(new Uint8Array([4, 5, 255]));
    expect(calls.find(({ url }) => url.includes("/files/list?"))?.url)
      .toContain("dir=%2Fapp%2Fnested+dir");
    const requestCall = calls.find(({ url }) => url.endsWith("/request"));
    expect(JSON.parse(String(requestCall?.init.body))).toEqual({
      method: "POST",
      path: "/fn/echo",
      headers: { "x-input": "yes" },
      body_b64: Buffer.from([6, 7, 255]).toString("base64"),
    });
    for (const { init } of calls) {
      expect(init.headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${apiKey}` }));
    }
  });

  it("defaults to VENDO_API_KEY and the hosted broker URL", async () => {
    vi.stubEnv("VENDO_API_KEY", apiKey);
    const fetcher = vi.fn(async () => jsonResponse({ id: "m_env", url: "https://m_env.m.vendo.run" }));
    vi.stubGlobal("fetch", fetcher);

    await vendoSandbox().create({ env: {} });

    expect(fetcher).toHaveBeenCalledWith(
      "https://console.vendo.run/api/v1/sandboxes",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${apiKey}` }),
      }),
    );
  });

  it("requires VENDO_API_KEY before making a broker request", async () => {
    vi.stubEnv("VENDO_API_KEY", "");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(vendoSandbox().create({ env: {} })).rejects.toMatchObject({
      code: "cloud-required",
      message: "Vendo Cloud requires VENDO_API_KEY",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-vendo and empty snapshot references before fetch", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const adapter = vendoSandbox({ apiKey });

    await expect(adapter.resume("e2b:snap_123")).rejects.toMatchObject({ code: "validation" });
    await expect(adapter.resume("vendo:")).rejects.toMatchObject({ code: "validation" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [400, "validation", "validation"],
    [401, "unauthorized", "cloud-required"],
    [402, "cloud-required", "cloud-required"],
    [404, "not-found", "not-found"],
    [409, "conflict", "conflict"],
    [501, "sandbox-unavailable", "sandbox-unavailable"],
    [503, "unavailable", "sandbox-unavailable"],
  ] as const)("maps HTTP %i %s envelopes to VendoError(%s)", async (status, brokerCode, vendoCode) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      error: { code: brokerCode, message: `broker says ${brokerCode}` },
    }, status)));

    const failure = vendoSandbox({ apiKey }).create({ env: {} });
    await expect(failure).rejects.toBeInstanceOf(VendoError);
    await expect(failure).rejects.toMatchObject({
      code: vendoCode,
      message: `broker says ${brokerCode}`,
    });
  });

  it("maps quota-exhausted without widening the frozen VendoError taxonomy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      error: {
        code: "quota-exhausted",
        message: "sandbox_minutes exhausted",
        meter: "sandbox_minutes",
      },
    }, 402)));

    await expect(vendoSandbox({ apiKey }).create({ env: {} })).rejects.toMatchObject({
      code: "cloud-required",
      message: "quota exhausted: upgrade or wait for period reset",
    });
  });

  it("preserves fetch network failures", async () => {
    const networkFailure = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(networkFailure)));

    await expect(vendoSandbox({ apiKey }).create({ env: {} })).rejects.toBe(networkFailure);
  });
});
