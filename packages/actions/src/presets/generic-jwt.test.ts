import { decodeProtectedHeader, jwtVerify } from "jose";
import type { PermissionGrant, Principal } from "@vendoai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { genericJwtPreset } from "./index.js";

const principal: Principal = { kind: "user", subject: "generic-user" };
const grant: PermissionGrant = {
  id: "grt_generic",
  subject: principal.subject,
  tool: "host_generic",
  descriptorHash: "sha256:generic",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-14T00:00:00.000Z",
};
const secret = "generic-jwt-secret-at-least-32-bytes-long";

describe("genericJwtPreset", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-07-14T12:00:00.000Z")));
  afterEach(() => vi.useRealTimers());

  it("supports custom claims, protected headers, and AuthMaterial header shape", async () => {
    const actAs = genericJwtPreset({
      secret,
      expiresInSeconds: 90,
      claims: (_principal, receivedGrant) => ({
        sub: "host-user-42",
        tenant: "tenant-a",
        permission: receivedGrant.tool,
      }),
      jwtHeader: { kid: "current-key", typ: "at+jwt" },
      headers: (token) => ({ "x-host-token": token, "x-token-kind": "vendo-act-as" }),
    });

    const material = await actAs(principal, grant);
    const token = material?.headers["x-host-token"] ?? "";
    const verified = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });

    expect(material?.headers["x-token-kind"]).toBe("vendo-act-as");
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "HS256", kid: "current-key", typ: "at+jwt" });
    expect(verified.payload).toMatchObject({
      sub: "host-user-42",
      tenant: "tenant-a",
      permission: grant.tool,
    });
  });

  it("caches matching material, refreshes near expiry, and declines explicitly", async () => {
    const actAs = genericJwtPreset({ secret, expiresInSeconds: 60, cacheSafetySeconds: 5 });
    const first = await actAs(principal, grant);
    vi.advanceTimersByTime(54_000);
    expect(await actAs(principal, grant)).toEqual(first);
    vi.advanceTimersByTime(2_000);
    expect((await actAs(principal, grant))?.headers.authorization).not.toBe(first?.headers.authorization);

    await expect(genericJwtPreset({ secret, claims: () => null })(principal, grant)).resolves.toBeNull();
    await expect(genericJwtPreset({ secret: async () => undefined })(principal, grant)).resolves.toBeNull();
  });
});
