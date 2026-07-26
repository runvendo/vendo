import { afterEach, describe, expect, it, vi } from "vitest";
import { demoRequestAllowed, publicVendoRequest } from "./request";

afterEach(() => vi.unstubAllEnvs());

describe("demoRequestAllowed", () => {
  const requestFor = (host: string) =>
    new Request(`https://${host}/api/demo/reset`, { method: "POST", headers: { host } });

  it("allows local hosts outside production", () => {
    expect(demoRequestAllowed(requestFor("localhost:3000"))).toBe(true);
  });

  it("refuses non-local hosts in production with no configured origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(demoRequestAllowed(requestFor("demo-maple.up.railway.app"))).toBe(false);
  });

  it("allows the deployed origin (VENDO_BASE_URL) in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VENDO_BASE_URL", "https://demo-maple.up.railway.app");
    expect(demoRequestAllowed(requestFor("demo-maple.up.railway.app"))).toBe(true);
  });

  it("still refuses other origins when a deployed origin is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VENDO_BASE_URL", "https://demo-maple.up.railway.app");
    expect(demoRequestAllowed(requestFor("evil.example.com"))).toBe(false);
  });

  it("prefers MAPLE_DEMO_ORIGIN over VENDO_BASE_URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VENDO_BASE_URL", "https://internal.example.com");
    vi.stubEnv("MAPLE_DEMO_ORIGIN", "https://maple.demos.example.com");
    expect(demoRequestAllowed(requestFor("maple.demos.example.com"))).toBe(true);
    expect(demoRequestAllowed(requestFor("internal.example.com"))).toBe(false);
  });
});

describe("publicVendoRequest", () => {
  it("rewrites the proxy origin and preserves the request", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://maple.example.com");
    const request = new Request("http://0.0.0.0:3000/api/vendo/mcp/token?proof=1", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });

    const rewritten = publicVendoRequest(request);

    expect(rewritten.url).toBe("https://maple.example.com/api/vendo/mcp/token?proof=1");
    expect(rewritten.method).toBe("POST");
    expect(rewritten.headers.get("authorization")).toBe("Bearer test");
    await expect(rewritten.json()).resolves.toEqual({ ok: true });
  });

  it("returns the original request without an operator-configured base URL", () => {
    vi.stubEnv("VENDO_BASE_URL", "");
    const request = new Request("http://localhost:3000/api/vendo/status");

    expect(publicVendoRequest(request)).toBe(request);
  });
});
