import { afterEach, describe, expect, it, vi } from "vitest";
import { publicVendoRequest } from "./request";

afterEach(() => vi.unstubAllEnvs());

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
