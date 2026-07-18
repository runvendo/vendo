import { encode } from "next-auth/jwt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMapleSession, safeReturnTo } from "./auth";

afterEach(() => vi.unstubAllEnvs());

const DEV_SECRET = "maple-local-development-auth-secret";
const COOKIE = "authjs.session-token";

async function sessionCookie(sub: string): Promise<string> {
  const token = await encode({ token: { sub }, secret: DEV_SECRET, salt: COOKIE, maxAge: 300 });
  return `${COOKIE}=${token}`;
}

describe("Maple Auth.js sessions", () => {
  it("resolves a real Auth.js session cookie to the seeded user", async () => {
    const cookie = await sessionCookie("vendo-demo");
    await expect(resolveMapleSession(new Request("http://localhost:3000/", {
      headers: { cookie },
    }))).resolves.toMatchObject({ subject: "vendo-demo", display: "Yousef Helal" });
  });

  it("rejects tampered cookies, unknown subjects, and missing sessions", async () => {
    const cookie = await sessionCookie("vendo-demo");
    await expect(resolveMapleSession(new Request("http://localhost:3000/", {
      headers: { cookie: `${cookie.slice(0, -2)}xx` },
    }))).resolves.toBeNull();
    await expect(resolveMapleSession(new Request("http://localhost:3000/", {
      headers: { cookie: await sessionCookie("user_stranger") },
    }))).resolves.toBeNull();
    await expect(resolveMapleSession(new Request("http://localhost:3000/")))
      .resolves.toBeNull();
  });
});

describe("safeReturnTo", () => {
  it("only accepts same-origin return targets", () => {
    vi.stubEnv("VENDO_BASE_URL", "https://maple.example.com");
    expect(safeReturnTo("https://maple.example.com/api/vendo/mcp/authorize?state=ok"))
      .toBe("/api/vendo/mcp/authorize?state=ok");
    expect(safeReturnTo("/settings")).toBe("/settings");
    expect(safeReturnTo("https://attacker.example/callback")).toBe("/");
    expect(safeReturnTo(null)).toBe("/");
  });
});
