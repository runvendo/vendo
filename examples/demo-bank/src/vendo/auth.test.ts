import type { PermissionGrant } from "@vendoai/core";
import { authJs } from "@vendoai/vendo/auth/auth-js";
import { encode } from "next-auth/jwt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authSecret, resolveMapleSubject } from "@/server/users";
import { BASE_PATH } from "@/lib/base-path";
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
    // Corrupt a FULLY-USED character of the JWE's tag. The old
    // `slice(0, -2) + "xx"` tamper was a NO-OP roughly 1/1024 runs: only the
    // token's FINAL base64url char carries discarded bits, and a token
    // ending "xw" differs from the "xx" replacement solely in those
    // discarded bits, so the "tampered" cookie still decoded to the real
    // session (CI integration failure, 2026-07-26). Flipping a character
    // five places from the end always lands on fully-used bits, so the tag
    // always changes and the decode must always reject.
    const at = cookie.length - 5;
    const tampered = `${cookie.slice(0, at)}${cookie[at] === "x" ? "y" : "x"}${cookie.slice(at + 1)}`;
    await expect(resolveMapleSession(new Request("http://localhost:3000/", {
      headers: { cookie: tampered },
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

  /** #867: VENDO_BASE_URL now carries /maple, and what comes back is the
   *  PUBLIC spelling — the browser's own. Callers must not run it through
   *  withBasePath() again; that produced /maple/maple/…. */
  it("returns the public spelling when the base URL carries a path prefix", () => {
    vi.stubEnv("VENDO_BASE_URL", "https://maple.example.com/maple");
    expect(safeReturnTo("https://maple.example.com/maple/api/vendo/mcp/authorize?state=ok"))
      .toBe("/maple/api/vendo/mcp/authorize?state=ok");
    // A refused target collapses to the app's OWN home, not the origin root —
    // under a mount point "/" serves nothing, so it is a 404, not a homepage.
    expect(safeReturnTo("https://attacker.example/maple/callback")).toBe("/maple");
    expect(safeReturnTo(null)).toBe("/maple");
    // Belt and braces (browser proof, 2026-08-06): a returnTo in the app's
    // mount-STRIPPED vocabulary — an old bookmark of the pre-fix /login link —
    // still lands somewhere that exists instead of 404ing after sign-in.
    expect(safeReturnTo("/insights")).toBe("/maple/insights");
  });

  /** returnTo is the one attacker-reachable input on the sign-in path and its
   *  output is emitted verbatim as a Location, so the open-redirect property is
   *  absolute: whatever comes back is a path under this deployment's mount and
   *  NEVER carries an authority. Every spelling that smuggles a host past a
   *  string check is listed — protocol-relative, backslash-relative, a
   *  whitespace-split scheme, an encoded double slash — because the prefixing
   *  step concatenates and a leading `//` would turn a path into an origin. */
  it.each([
    "//evil.example/phish",
    "/\\evil.example/phish",
    "\\\\evil.example/phish",
    "https:/\\evil.example/phish",
    "java\tscript:alert(1)",
    "/%2f%2fevil.example/phish",
  ])("never turns %j into an authority", (candidate) => {
    vi.stubEnv("VENDO_BASE_URL", "https://maple.example.com/maple");
    const target = safeReturnTo(candidate);
    expect(target === "/maple" || target.startsWith("/maple/")).toBe(true);
  });
});
