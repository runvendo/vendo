import type { PermissionGrant } from "@vendoai/core";
import { authJs } from "@vendoai/vendo/server";
import { encode } from "next-auth/jwt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authSecret, resolveMapleSubject } from "@/server/users";
import { resolveMapleSession, safeReturnTo } from "./auth";

afterEach(() => vi.unstubAllEnvs());

const DEV_SECRET = "maple-local-development-auth-secret";
const COOKIE = "authjs.session-token";

function grantFor(subject: string): PermissionGrant {
  return {
    id: "grt_test",
    subject,
    tool: "host_transferMoney",
    descriptorHash: "sha256:test",
    scope: { kind: "tool" },
    duration: "standing",
    source: "automation",
    grantedAt: "2026-07-15T00:00:00.000Z",
  };
}

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

// The exact server.ts config (./server.ts): one preset, Maple's own secret and
// subject resolver.
const auth = authJs({
  secret: authSecret,
  user: (subject) => {
    const user = resolveMapleSubject(subject);
    return user ? { display: user.display, email: user.email } : null;
  },
});

describe("authJs's actAs half (away/MCP minting) — the session resolveMapleSession reads", () => {
  it("mints an away session Maple's own session reads accept", async () => {
    // Cross-package proof: the preset's actAs half encodes the session JWE
    // through @vendoai/actions' bundled @auth/core, while resolveMapleSession
    // (and /api/transfers, /api/profile, /login) decode it through
    // next-auth's own bundled @auth/core. The two must agree on wire format
    // or away/MCP execution mints cookies the app itself cannot read.
    const material = await auth.actAs!(
      { kind: "user", subject: "maple-mia", display: "Mia Nakamura" },
      grantFor("maple-mia"),
    );
    expect(material?.headers.cookie).toMatch(/^authjs\.session-token=/);
    await expect(resolveMapleSession(new Request("http://localhost:3000/api/transfers", {
      headers: material!.headers,
    }))).resolves.toMatchObject({ subject: "maple-mia", email: "mia@maple.com" });
  });

  it("declines subjects Maple never issued", async () => {
    await expect(auth.actAs!(
      { kind: "user", subject: "user_stranger" },
      grantFor("user_stranger"),
    )).resolves.toBeNull();
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
