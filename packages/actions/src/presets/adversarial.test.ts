import type { PermissionGrant, Principal } from "@vendoai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auth0Preset,
  authJsPreset,
  clerkPreset,
  genericJwtPreset,
  supabasePreset,
} from "./index.js";
import { signHs256 } from "./shared.js";

// Red-team suite for @vendoai/actions/presets. actAs material is host
// authority: a forged, replayed, or tampered away-token must never verify, and
// the signing secret must never surface in AuthMaterial or logs.

const principal: Principal = { kind: "user", subject: "victim-user" };
const grant: PermissionGrant = {
  id: "grt_victim",
  subject: principal.subject,
  tool: "host_transfer_create",
  descriptorHash: "sha256:victim",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-14T00:00:00.000Z",
};
const secret = "away-token-secret-belonging-to-the-host-32b";
const attackerSecret = "attacker-chosen-secret-also-32-bytes-long";

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

describe("away-token forgery and replay", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-07-14T12:00:00.000Z")));
  afterEach(() => vi.useRealTimers());

  it("rejects a token signed with a secret the host never issued", async () => {
    const forged = await signHs256(
      {
        iss: "vendo",
        aud: "vendo-away",
        sub: principal.subject,
        provider: "clerk",
        grantId: grant.id,
        tool: grant.tool,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      attackerSecret,
      { typ: "vendo-away+jwt" },
    );
    const verifier = clerkPreset({ secret });

    await expect(verifier.verify(forged)).rejects.toThrow("invalid JWT signature");
    const response = await verifier.nextMiddleware(new Request("https://host.test/api/probe", {
      headers: { authorization: `VendoAway ${forged}` },
    }));
    expect(response.status).toBe(401);
  });

  it("rejects a legitimate token whose subject was swapped after signing", async () => {
    const created = clerkPreset({ secret });
    const material = await created.actAs(principal, grant);
    const token = (material?.headers.authorization ?? "").replace(/^VendoAway /, "");
    const [header = "", payload = "", signature = ""] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const tampered = `${header}.${base64Url(JSON.stringify({ ...claims, sub: "attacker-user" }))}.${signature}`;

    await expect(created.verify(tampered)).rejects.toThrow("invalid JWT signature");
  });

  it("rejects an unsigned alg:none token even when its claims are perfect", async () => {
    const header = base64Url(JSON.stringify({ alg: "none", typ: "vendo-away+jwt" }));
    const payload = base64Url(JSON.stringify({
      iss: "vendo",
      aud: "vendo-away",
      sub: principal.subject,
      provider: "clerk",
      grantId: grant.id,
      tool: grant.tool,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }));
    const verifier = clerkPreset({ secret });

    await expect(verifier.verify(`${header}.${payload}.`)).rejects.toThrow();
    await expect(verifier.verify(`${header}.${payload}`)).rejects.toThrow();
  });

  it("rejects a Clerk-minted token replayed against the Auth0 verifier", async () => {
    const clerk = clerkPreset({ secret });
    const auth0 = auth0Preset({ secret });
    const material = await clerk.actAs(principal, grant);

    await expect(auth0.verify(material?.headers.authorization ?? ""))
      .rejects.toThrow("invalid Vendo away-token claims");
  });

  it("rejects a token minted for a different issuer or audience", async () => {
    const otherHost = clerkPreset({ secret, issuer: "other-product", audience: "other-api" });
    const verifier = clerkPreset({ secret });
    const material = await otherHost.actAs(principal, grant);

    await expect(verifier.verify(material?.headers.authorization ?? ""))
      .rejects.toThrow(/invalid JWT (issuer|audience)/);
  });

  it("rejects a plain HS256 JWT that lacks the vendo-away token type", async () => {
    const lookalike = genericJwtPreset({
      secret,
      claims: () => ({
        iss: "vendo",
        aud: "vendo-away",
        provider: "clerk",
        grantId: grant.id,
        tool: grant.tool,
      }),
    });
    const verifier = clerkPreset({ secret });
    const material = await lookalike(principal, grant);
    const token = (material?.headers.authorization ?? "").replace(/^Bearer /, "");

    await expect(verifier.verify(token)).rejects.toThrow("invalid JWT type");
  });
});

describe("trusted header spoofing", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-07-14T12:00:00.000Z")));
  afterEach(() => vi.useRealTimers());

  it("strips caller-supplied x-vendo-away-* headers from ordinary requests", async () => {
    const created = clerkPreset({ secret });
    const response = await created.nextMiddleware(new Request("https://host.test/api/probe", {
      headers: {
        authorization: "Bearer ordinary-provider-session",
        "x-vendo-away-subject": "attacker-user",
        "x-vendo-away-provider": "clerk",
        "x-vendo-away-grant": "grt_forged",
        "x-vendo-away-tool": "host_transfer_create",
      },
    }));

    expect(response.status).toBe(200);
    for (const name of ["subject", "provider", "grant", "tool"]) {
      expect(response.headers.get(`x-middleware-request-x-vendo-away-${name}`)).toBeNull();
    }
    // The provider session continues to the host verifier untouched.
    expect(response.headers.get("x-middleware-request-authorization"))
      .toBe("Bearer ordinary-provider-session");
  });

  it("overwrites spoofed identity headers with the verified claims on away requests", async () => {
    const created = clerkPreset({ secret });
    const material = await created.actAs(principal, grant);
    const response = await created.nextMiddleware(new Request("https://host.test/api/probe", {
      headers: {
        authorization: material?.headers.authorization ?? "",
        "x-vendo-away-subject": "attacker-user",
      },
    }));

    expect(response.headers.get("x-middleware-request-x-vendo-away-subject")).toBe(principal.subject);
  });
});

describe("secret containment", () => {
  const presets = [
    ["Generic JWT", genericJwtPreset({ secret })],
    ["Auth.js", authJsPreset({ secret })],
    ["Supabase Auth", supabasePreset({ secret })],
    ["Clerk away-token", clerkPreset({ secret }).actAs],
    ["Auth0 away-token", auth0Preset({ secret }).actAs],
  ] as const;

  it.each(presets)("%s never leaks the signing secret into AuthMaterial or console output", async (_name, actAs) => {
    const spies = (["log", "info", "warn", "error", "debug"] as const)
      .map((level) => vi.spyOn(console, level));
    try {
      const material = await actAs(principal, grant);

      expect(material).not.toBeNull();
      const serialized = JSON.stringify(material);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(Buffer.from(secret, "utf8").toString("base64url"));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("declines with a bare null (no secret-bearing error) when the secret resolver throws-adjacent returns nothing", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const)
      .map((level) => vi.spyOn(console, level));
    try {
      const actAs = genericJwtPreset({ secret: async () => undefined });
      await expect(actAs(principal, grant)).resolves.toBeNull();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
