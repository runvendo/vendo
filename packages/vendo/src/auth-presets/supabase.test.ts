import { supabasePreset } from "@vendoai/actions/presets";
import type { PermissionGrant } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
// Imported through the same entry hosts use, pinning the re-export.
import { hostAuthPresetConformance, supabase } from "./index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const secret = "supabase-project-jwt-secret-at-least-32-bytes";

/** The host-side user table a subject→user resolver fronts (demo-bank idiom). */
const users: Record<string, { display: string; email: string }> = {
  supa_yousef: { display: "Yousef Helal", email: "yousef@supa.test" },
};
const userResolver = (subject: string): { display: string; email: string } | null =>
  users[subject] ?? null;

const grantFor = (subject: string): PermissionGrant => ({
  id: "grt_supabase_preset_test",
  subject,
  tool: "host_invoices_list",
  descriptorHash: "sha256:supabase-preset-test",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-18T00:00:00.000Z",
});

/** Mint a REAL Supabase HS256 access token hermetically the way the actions
    half's own tests do — the shipped supabasePreset with the project secret. */
async function accessToken(subject: string, claims: Record<string, unknown> = {}): Promise<string> {
  const mint = supabasePreset({ secret, claims: () => claims });
  const material = await mint({ kind: "user", subject }, grantFor(subject));
  return material!.headers["authorization"]!.replace(/^Bearer /, "");
}

/** The @supabase/ssr cookie shape: `sb-<ref>-auth-token` holding `base64-` +
    base64url(JSON session), optionally chunked across `.0`, `.1`, ... */
function ssrCookieValue(token: string): string {
  const session = JSON.stringify({ access_token: token, token_type: "bearer" });
  return `base64-${Buffer.from(session, "utf8").toString("base64url")}`;
}

function withCookie(cookie: string): Request {
  return new Request("https://host.test/api/vendo/threads", { headers: { cookie } });
}

async function sessionRequest(subject: string, claims: Record<string, unknown> = {}): Promise<Request> {
  return withCookie(`sb-testref-auth-token=${ssrCookieValue(await accessToken(subject, claims))}`);
}

describe("supabase() three-seam conformance (09 §2.1)", () => {
  const suite = hostAuthPresetConformance({
    preset: supabase({ secret, user: userResolver }),
    sessionRequest: (subject) => sessionRequest(subject),
    knownSubject: "supa_yousef",
    unknownSubject: "intruder",
    expectedDisplay: "Yousef Helal",
  });
  for (const conformanceCase of suite.cases) {
    it(conformanceCase.name, conformanceCase.run);
  }
});

describe("supabase() zero-argument standard case", () => {
  it("reads SUPABASE_JWT_SECRET from the environment", async () => {
    vi.stubEnv("SUPABASE_JWT_SECRET", secret);
    const preset = supabase();
    await expect(preset.principal(await sessionRequest("user_env")))
      .resolves.toEqual({ kind: "user", subject: "user_env" });
  });

  it("throws an actionable error naming SUPABASE_JWT_SECRET when no secret is configured", async () => {
    vi.stubEnv("SUPABASE_JWT_SECRET", "");
    const preset = supabase();
    await expect(preset.principal(await sessionRequest("user_env")))
      .rejects.toThrow(/SUPABASE_JWT_SECRET/);
  });
});

describe("supabase() session resolution — Supabase's own formats", () => {
  it("accepts the Authorization: Bearer access token (how Supabase clients call the API)", async () => {
    const preset = supabase({ secret });
    const request = new Request("https://host.test/api/vendo/threads", {
      headers: { authorization: `Bearer ${await accessToken("user_bearer")}` },
    });
    await expect(preset.principal(request)).resolves.toEqual({ kind: "user", subject: "user_bearer" });
  });

  it("reads a CHUNKED @supabase/ssr cookie (sb-<ref>-auth-token.0/.1) reassembled in order", async () => {
    const preset = supabase({ secret });
    const value = ssrCookieValue(await accessToken("user_chunked"));
    const middle = Math.floor(value.length / 2);
    const cookie = `sb-testref-auth-token.0=${value.slice(0, middle)}; sb-testref-auth-token.1=${value.slice(middle)}`;
    await expect(preset.principal(withCookie(cookie))).resolves.toEqual({ kind: "user", subject: "user_chunked" });
  });

  it("reads the plain-JSON legacy cookie shape (object and [access_token, ...] array)", async () => {
    const preset = supabase({ secret });
    const token = await accessToken("user_legacy");
    const objectCookie = `sb-testref-auth-token=${encodeURIComponent(JSON.stringify({ access_token: token }))}`;
    await expect(preset.principal(withCookie(objectCookie))).resolves.toEqual({ kind: "user", subject: "user_legacy" });
    const arrayCookie = `sb-testref-auth-token=${encodeURIComponent(JSON.stringify([token, "refresh"]))}`;
    await expect(preset.principal(withCookie(arrayCookie))).resolves.toEqual({ kind: "user", subject: "user_legacy" });
  });

  it("resolves a cookie-less request to null and an unverifiable token to null", async () => {
    const preset = supabase({ secret });
    await expect(preset.principal(new Request("https://host.test/api/vendo/threads"))).resolves.toBeNull();
    const forged = supabasePreset({ secret: "a-different-project-secret-entirely" });
    const material = await forged({ kind: "user", subject: "user_forged" }, grantFor("user_forged"));
    await expect(preset.principal(new Request("https://host.test/api/vendo/threads", { headers: material!.headers })))
      .resolves.toBeNull();
  });
});

describe("supabase() claims mapping and user resolver", () => {
  it("derives display from user_metadata.name, falling back through full_name to email", async () => {
    const preset = supabase({ secret });
    await expect(preset.principal(await sessionRequest("u1", {
      email: "ada@supa.test",
      user_metadata: { name: "Ada Lovelace" },
    }))).resolves.toEqual({ kind: "user", subject: "u1", display: "Ada Lovelace" });
    await expect(preset.principal(await sessionRequest("u2", {
      email: "ada@supa.test",
      user_metadata: { full_name: "Ada King" },
    }))).resolves.toEqual({ kind: "user", subject: "u2", display: "Ada King" });
    await expect(preset.principal(await sessionRequest("u3", { email: "ada@supa.test" })))
      .resolves.toEqual({ kind: "user", subject: "u3", display: "ada@supa.test" });
  });

  it("user overrides claims-derived identity and null declines the session", async () => {
    const preset = supabase({ secret, user: userResolver });
    await expect(preset.principal(await sessionRequest("supa_yousef", {
      user_metadata: { name: "Claims Name Ignored" },
    }))).resolves.toEqual({ kind: "user", subject: "supa_yousef", display: "Yousef Helal" });
    await expect(preset.principal(await sessionRequest("ghost"))).resolves.toBeNull();
  });

  it("user identity reaches the actAs mint — email and user_metadata.name ride the minted token", async () => {
    const preset = supabase({ secret, user: userResolver });
    const material = await preset.actAs?.({ kind: "user", subject: "supa_yousef" }, grantFor("supa_yousef"));
    expect(material).not.toBeNull();
    // The minted token round-trips through the preset's own resolver WITHOUT
    // the user override, proving the identity is inside the token itself.
    const claimsOnly = supabase({ secret });
    const authed = new Request("https://host.test/api/vendo/doctor/act-as/echo", { headers: material!.headers });
    await expect(claimsOnly.principal(authed))
      .resolves.toEqual({ kind: "user", subject: "supa_yousef", display: "Yousef Helal" });
  });
});
