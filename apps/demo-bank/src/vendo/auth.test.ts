import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticateMapleUser,
  createMapleSessionCookie,
  resolveMapleSession,
  safeReturnTo,
} from "./auth";

afterEach(() => vi.unstubAllEnvs());

describe("Maple demo auth", () => {
  it("authenticates the configured seeded demo user", async () => {
    vi.stubEnv("MAPLE_DEMO_EMAIL", "demo@maple.test");
    vi.stubEnv("MAPLE_DEMO_PASSWORD", "correct horse battery staple");
    vi.stubEnv("MAPLE_SESSION_SECRET", "a-long-test-only-session-secret");

    await expect(authenticateMapleUser("DEMO@MAPLE.TEST", "correct horse battery staple"))
      .resolves.toMatchObject({ subject: "vendo-demo", email: "demo@maple.test" });
    await expect(authenticateMapleUser("demo@maple.test", "wrong" )).resolves.toBeNull();
  });

  it("round-trips the signed HttpOnly session cookie and rejects tampering", async () => {
    vi.stubEnv("MAPLE_DEMO_EMAIL", "demo@maple.test");
    vi.stubEnv("MAPLE_DEMO_PASSWORD", "correct horse battery staple");
    vi.stubEnv("MAPLE_SESSION_SECRET", "a-long-test-only-session-secret");
    vi.stubEnv("VENDO_BASE_URL", "https://maple.example.com");
    const user = await authenticateMapleUser("demo@maple.test", "correct horse battery staple");
    expect(user).not.toBeNull();

    const setCookie = await createMapleSessionCookie(
      new Request("http://0.0.0.0:3000/api/auth/login"),
      user!,
    );
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    const cookie = setCookie.split(";", 1)[0]!;

    await expect(resolveMapleSession(new Request("https://maple.example.com/", {
      headers: { cookie },
    }))).resolves.toMatchObject({ subject: "vendo-demo" });

    const tampered = `${cookie.slice(0, -1)}x`;
    await expect(resolveMapleSession(new Request("https://maple.example.com/", {
      headers: { cookie: tampered },
    }))).resolves.toBeNull();
  });

  it("only accepts same-origin login return targets", () => {
    vi.stubEnv("VENDO_BASE_URL", "https://maple.example.com");
    const request = new Request("http://0.0.0.0:3000/api/auth/login");

    expect(safeReturnTo(request, "https://maple.example.com/api/vendo/mcp/authorize?state=ok"))
      .toBe("/api/vendo/mcp/authorize?state=ok");
    expect(safeReturnTo(request, "https://attacker.example/callback")).toBe("/");
  });
});
