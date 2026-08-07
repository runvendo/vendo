import type { PermissionGrant, Principal } from "@vendoai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth0Preset, clerkPreset, type AwayTokenPreset } from "./index.js";

const principal: Principal = { kind: "user", subject: "provider-user" };
const grant: PermissionGrant = {
  id: "grt_provider",
  subject: principal.subject,
  tool: "host_transfer_create",
  descriptorHash: "sha256:provider",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-14T00:00:00.000Z",
};
const secret = "vendo-away-token-secret-at-least-32-bytes";

type ExpressRequest = { headers: Record<string, string | undefined>; vendoAwayToken?: unknown };

describe.each([
  ["Clerk", "clerk", clerkPreset],
  ["Auth0", "auth0", auth0Preset],
] as const)("%s away-token preset", (_label, provider, makePreset) => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-07-14T12:00:00.000Z")));
  afterEach(() => vi.useRealTimers());

  function preset(): AwayTokenPreset {
    return makePreset({ secret, expiresInSeconds: 60, cacheSafetySeconds: 5 });
  }

  it("mints a short-lived VendoAway token and verifies a doctor-probeable round trip", async () => {
    const created = preset();
    const material = await created.actAs(principal, grant);
    const authorization = material?.headers.authorization ?? "";
    const claims = await created.verify(authorization);

    expect(authorization).toMatch(/^VendoAway /);
    expect(claims).toMatchObject({
      iss: "vendo",
      aud: "vendo-away",
      sub: principal.subject,
      provider,
      grantId: grant.id,
      tool: grant.tool,
    });
    expect(claims.exp).toBe(claims.iat + 60);
  });

  it("caches through the safety window, refreshes, and supports host decline", async () => {
    const created = preset();
    const first = await created.actAs(principal, grant);
    vi.advanceTimersByTime(54_000);
    expect(await created.actAs(principal, grant)).toEqual(first);
    vi.advanceTimersByTime(2_000);
    expect((await created.actAs(principal, grant))?.headers.authorization).not.toBe(first?.headers.authorization);

    const denied = makePreset({ secret, claims: () => null });
    await expect(denied.actAs(principal, grant)).resolves.toBeNull();
    const missingSecret = makePreset({ secret: async () => undefined });
    await expect(missingSecret.actAs(principal, grant)).resolves.toBeNull();
  });

  it("rejects an expired away-token", async () => {
    const created = preset();
    const material = await created.actAs(principal, grant);
    vi.advanceTimersByTime(61_000);

    await expect(created.verify(material?.headers.authorization ?? "")).rejects.toThrow("expired JWT");
  });

  it("ships Express middleware that verifies away auth without swallowing provider auth", async () => {
    const created = preset();
    const material = await created.actAs(principal, grant);
    const request: ExpressRequest = { headers: { authorization: material?.headers.authorization } };
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    await created.expressMiddleware(request, response, next);

    expect(next).toHaveBeenCalledWith();
    expect(request.vendoAwayToken).toMatchObject({ sub: principal.subject, provider });

    const providerRequest: ExpressRequest = { headers: { authorization: "Bearer provider-token" } };
    await created.expressMiddleware(providerRequest, response, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(providerRequest.vendoAwayToken).toBeUndefined();
  });

  it("fails invalid away tokens closed in both Express and Next.js middleware", async () => {
    const created = preset();
    const request: ExpressRequest = { headers: { authorization: "VendoAway invalid" } };
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    await created.expressMiddleware(request, response, next);
    const nextResponse = await created.nextMiddleware(new Request("https://host.test/api/probe", {
      headers: { authorization: "VendoAway invalid" },
    }));

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: "invalid-vendo-away-token" });
    expect(nextResponse.status).toBe(401);
    await expect(nextResponse.json()).resolves.toEqual({ error: "invalid-vendo-away-token" });
  });

  it("injects verified identity headers through real Next.js middleware semantics", async () => {
    const created = preset();
    const material = await created.actAs(principal, grant);
    const response = await created.nextMiddleware(new Request("https://host.test/api/probe", {
      headers: { authorization: material?.headers.authorization ?? "" },
    }));

    expect(response.headers.get("x-middleware-request-x-vendo-away-subject")).toBe(principal.subject);
    expect(response.headers.get("x-middleware-request-x-vendo-away-provider")).toBe(provider);
    expect(response.headers.get("x-middleware-request-x-vendo-away-grant")).toBe(grant.id);
    expect(response.headers.get("x-middleware-request-x-vendo-away-tool")).toBe(grant.tool);
  });
});
