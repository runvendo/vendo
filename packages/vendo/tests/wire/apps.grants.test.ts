import type { AccessLevel, AppGrantRecord, Membership, RunContext } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { appRoutes } from "../../src/wire/apps.js";
import { dispatchRoutes, routeSegments, type WireDeps } from "../../src/wire/shared.js";

/** Build contract §9.2 — the ✦ toggle's door. ONE round trip tells the menu
    which tenant to name and whether the share is on. */

const ctx = (memberships: Membership[] = []): RunContext => ({
  principal: { kind: "user", subject: "alice" },
  venue: "app",
  presence: "present",
  sessionId: "s_alice",
  ...(memberships.length === 0 ? {} : { memberships }),
});

const grantRow = (principal: string): AppGrantRecord => ({
  id: "g_1", appId: "app_1" as never, orgId: "acme", principal, level: "viewer",
  createdBy: "alice", createdAt: "2026-08-01T00:00:00.000Z",
});

const wireFor = (over: {
  level?: AccessLevel | null;
  grants?: AppGrantRecord[];
  memberships?: Membership[];
  grant?: WireDeps["apps"]["access"]["grant"];
  revoke?: WireDeps["apps"]["access"]["revoke"];
}) => {
  const deps = {
    apps: {
      access: {
        levelFor: async () => over.level ?? "owner",
        list: async () => over.grants ?? [],
        grant: over.grant ?? (async () => over.grants ?? []),
        revoke: over.revoke ?? (async () => []),
      },
    },
  } as unknown as WireDeps;
  return async (method: string, path: string, body?: unknown): Promise<Response | undefined> => {
    const url = new URL(`https://maple.test/api/vendo${path}`);
    return dispatchRoutes(appRoutes, {
      request: new Request(url, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      }),
      url,
      path,
      segments: routeSegments(path),
      params: {},
      context: async () => ctx(over.memberships ?? []),
      sweep: async () => {},
      deps,
    } as never);
  };
};

describe("§9.2 — /apps/:id/grants", () => {
  it("answers the level, the grants, and the caller's own orgs in one GET", async () => {
    const send = wireFor({
      level: "owner",
      grants: [grantRow("org:acme")],
      memberships: [{ org: "acme", display: "Acme Corp" }],
    });
    const response = await send("GET", "/apps/app_1/grants");
    await expect(response!.json()).resolves.toEqual({
      level: "owner",
      grants: [grantRow("org:acme")],
      orgs: [{ org: "acme", display: "Acme Corp" }],
    });
  });

  it("omits display for an org the host named no display for", async () => {
    const send = wireFor({ memberships: [{ org: "acme" }] });
    const body = await (await send("GET", "/apps/app_1/grants"))!.json();
    expect(body.orgs).toEqual([{ org: "acme" }]);
  });

  it("writes a grant and answers with the resulting list", async () => {
    const grant = vi.fn(async () => [grantRow("org:acme")]);
    const send = wireFor({ grant: grant as never });
    const response = await send("PUT", "/apps/app_1/grants/org%3Aacme", { level: "viewer" });
    expect(grant).toHaveBeenCalledWith("app_1", "org:acme", "viewer", expect.anything());
    await expect(response!.json()).resolves.toEqual({ grants: [grantRow("org:acme")] });
  });

  it("refuses a level outside the closed vocabulary before the store sees it", async () => {
    const grant = vi.fn();
    const send = wireFor({ grant: grant as never });
    await expect(send("PUT", "/apps/app_1/grants/org%3Aacme", { level: "admin" }))
      .rejects.toMatchObject({ code: "validation" });
    expect(grant).not.toHaveBeenCalled();
  });

  it("revokes and answers with what is left", async () => {
    const revoke = vi.fn(async () => []);
    const send = wireFor({ revoke: revoke as never });
    const response = await send("DELETE", "/apps/app_1/grants/org%3Aacme");
    expect(revoke).toHaveBeenCalledWith("app_1", "org:acme", expect.anything());
    await expect(response!.json()).resolves.toEqual({ grants: [] });
  });
});
