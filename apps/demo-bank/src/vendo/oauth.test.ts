import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateMapleUser, createMapleSessionCookie } from "./auth";
import { mapleOAuthAdapter } from "./oauth";

afterEach(() => vi.unstubAllEnvs());

describe("Maple HostOAuthAdapter", () => {
  it("bounces a missing session through Maple login with the exact returnTo", async () => {
    vi.stubEnv("MAPLE_DEMO_PASSWORD", "maple-test-password");
    vi.stubEnv("MAPLE_SESSION_SECRET", "maple-test-session-secret");
    vi.stubEnv("VENDO_BASE_URL", "https://maple.example.com");
    const returnTo = "https://maple.example.com/api/vendo/mcp/authorize?state=exact";

    const result = await mapleOAuthAdapter.session!(
      new Request("http://0.0.0.0:3000/api/vendo/mcp/authorize"),
      { returnTo },
    );

    expect(result).toBeInstanceOf(Response);
    const location = new URL((result as Response).headers.get("location")!);
    expect(location.origin).toBe("https://maple.example.com");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("returnTo")).toBe(returnTo);
  });

  it("maps the signed host session to a subject and keeps principal as the revocation seam", async () => {
    vi.stubEnv("MAPLE_DEMO_PASSWORD", "maple-test-password");
    vi.stubEnv("MAPLE_SESSION_SECRET", "maple-test-session-secret");
    const user = await authenticateMapleUser("yousef@maple.com", "maple-test-password");
    const setCookie = await createMapleSessionCookie(new Request("http://localhost:3000/login"), user!);
    const cookie = setCookie.split(";", 1)[0]!;

    await expect(mapleOAuthAdapter.session!(
      new Request("http://localhost:3000/api/vendo/mcp/authorize", { headers: { cookie } }),
      { returnTo: "http://localhost:3000/api/vendo/mcp/authorize" },
    )).resolves.toEqual({ subject: "vendo-demo" });
    await expect(mapleOAuthAdapter.principal("vendo-demo")).resolves.toMatchObject({
      kind: "user",
      subject: "vendo-demo",
    });
    await expect(mapleOAuthAdapter.principal("revoked-user")).resolves.toBeNull();
  });
});
