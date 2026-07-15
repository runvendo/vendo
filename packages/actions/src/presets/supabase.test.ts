import { jwtVerify } from "jose";
import type { PermissionGrant, Principal } from "@vendoai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supabasePreset } from "./index.js";

const principal: Principal = { kind: "user", subject: "supabase-user-id" };
const grant: PermissionGrant = {
  id: "grt_supabase",
  subject: principal.subject,
  tool: "host_invoices_list",
  descriptorHash: "sha256:supabase",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-14T00:00:00.000Z",
};
const secret = "supabase-project-jwt-secret-at-least-32-bytes";

function bearer(material: Awaited<ReturnType<ReturnType<typeof supabasePreset>>>): string {
  return material?.headers.authorization?.replace(/^Bearer /, "") ?? "";
}

describe("supabasePreset", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-07-14T12:00:00.000Z")));
  afterEach(() => vi.useRealTimers());

  it("mints an HS256 token with Supabase claims that jose accepts", async () => {
    const actAs = supabasePreset({ secret, audience: "authenticated", expiresInSeconds: 120 });
    const material = await actAs(principal, grant);
    const verified = await jwtVerify(bearer(material), new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      audience: "authenticated",
    });

    expect(verified.payload).toMatchObject({
      sub: principal.subject,
      role: "authenticated",
      aud: "authenticated",
    });
    expect(verified.payload.exp).toBe(verified.payload.iat! + 120);
  });

  it("caches per subject until the safety margin and then refreshes", async () => {
    const actAs = supabasePreset({ secret, expiresInSeconds: 60, cacheSafetySeconds: 5 });
    const first = await actAs(principal, grant);
    const other = await actAs({ ...principal, subject: "another-user" }, { ...grant, subject: "another-user" });
    vi.advanceTimersByTime(54_000);
    const cached = await actAs(principal, grant);
    vi.advanceTimersByTime(2_000);
    const refreshed = await actAs(principal, grant);

    expect(cached).toEqual(first);
    expect(other?.headers.authorization).not.toBe(first?.headers.authorization);
    expect(refreshed?.headers.authorization).not.toBe(first?.headers.authorization);
  });

  it("declines when the claims resolver or project secret is unavailable", async () => {
    await expect(supabasePreset({ secret, claims: () => null })(principal, grant)).resolves.toBeNull();
    await expect(supabasePreset({ secret: async () => undefined })(principal, grant)).resolves.toBeNull();
  });
});
