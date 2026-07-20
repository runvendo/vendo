import { getToken } from "@auth/core/jwt";
import type { PermissionGrant, Principal } from "@vendoai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// authJsPreset ships on its own module — not the shared "./index.js" barrel
// (corpus-triage Task 9) — so import it directly here too.
import { authJsPreset } from "./auth-js.js";

const principal: Principal = { kind: "user", subject: "user_authjs" };
const grant: PermissionGrant = {
  id: "grt_authjs",
  subject: principal.subject,
  tool: "host_profile",
  descriptorHash: "sha256:authjs",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-14T00:00:00.000Z",
};
const secret = "authjs-secret-for-real-jwe-verification";
const cookieName = "authjs.session-token";

describe("authJsPreset", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-07-14T12:00:00.000Z")));
  afterEach(() => vi.useRealTimers());

  it("mints an Auth.js v5 JWE accepted by the real getToken implementation", async () => {
    const actAs = authJsPreset({
      secret,
      cookieName,
      expiresInSeconds: 120,
      claims: () => ({ name: "Ada", email: "ada@example.com" }),
    });

    const material = await actAs(principal, grant);

    expect(material?.headers.cookie).toMatch(/^authjs\.session-token=/);
    const token = await getToken({
      req: { headers: material?.headers ?? {} },
      secret,
      cookieName,
    });
    expect(token).toMatchObject({
      sub: principal.subject,
      name: "Ada",
      email: "ada@example.com",
    });
  });

  it("caches until the safety margin and then refreshes", async () => {
    const actAs = authJsPreset({
      secret,
      cookieName,
      expiresInSeconds: 120,
      cacheSafetySeconds: 10,
    });

    const first = await actAs(principal, grant);
    vi.advanceTimersByTime(109_000);
    const cached = await actAs(principal, grant);
    vi.advanceTimersByTime(2_000);
    const refreshed = await actAs(principal, grant);

    expect(cached).toEqual(first);
    expect(refreshed?.headers.cookie).not.toBe(first?.headers.cookie);
  });

  it("never reuses a cached JWE once its whole-second Auth.js expiry is reached", async () => {
    vi.setSystemTime(new Date("2026-07-14T12:00:00.900Z"));
    const actAs = authJsPreset({
      secret,
      cookieName,
      expiresInSeconds: 60,
      cacheSafetySeconds: 0,
    });

    const first = await actAs(principal, grant);
    vi.advanceTimersByTime(59_100);
    const refreshed = await actAs(principal, grant);

    expect(refreshed?.headers.cookie).not.toBe(first?.headers.cookie);
    await expect(getToken({
      req: { headers: refreshed?.headers ?? {} },
      secret,
      cookieName,
    })).resolves.toMatchObject({ sub: principal.subject });
  });

  it("uses Auth.js's secure default cookie name when requested", async () => {
    const actAs = authJsPreset({ secret, secureCookie: true });
    const material = await actAs(principal, grant);

    expect(material?.headers.cookie).toMatch(/^__Secure-authjs\.session-token=/);
    await expect(getToken({
      req: { headers: material?.headers ?? {} },
      secret,
      secureCookie: true,
    })).resolves.toMatchObject({ sub: principal.subject });
  });

  it("declines when the host cannot resolve claims or the secret", async () => {
    const denied = authJsPreset({ secret, claims: () => null });
    const missingSecret = authJsPreset({ secret: async () => undefined });

    await expect(denied(principal, grant)).resolves.toBeNull();
    await expect(missingSecret(principal, grant)).resolves.toBeNull();
  });
});
