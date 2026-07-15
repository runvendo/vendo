import { encode } from "next-auth/jwt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapleOAuthAdapter } from "./oauth";

afterEach(() => vi.unstubAllEnvs());

async function sessionCookie(sub: string): Promise<string> {
  const token = await encode({
    token: { sub },
    secret: "maple-local-development-auth-secret",
    salt: "authjs.session-token",
    maxAge: 300,
  });
  return `authjs.session-token=${token}`;
}

describe("Maple HostOAuthAdapter", () => {
  it("bounces a missing session through Maple login with the exact returnTo", async () => {
    vi.stubEnv("VENDO_BASE_URL", "http://maple.example.com");
    const returnTo = "http://maple.example.com/api/vendo/mcp/authorize?state=exact";

    const result = await mapleOAuthAdapter.session!(
      new Request("http://0.0.0.0:3000/api/vendo/mcp/authorize"),
      { returnTo },
    );

    expect(result).toBeInstanceOf(Response);
    const location = new URL((result as Response).headers.get("location")!);
    expect(location.origin).toBe("http://maple.example.com");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("returnTo")).toBe(returnTo);
  });

  it("maps the real Auth.js session to a subject and keeps principal as the revocation seam", async () => {
    const cookie = await sessionCookie("vendo-demo");

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
