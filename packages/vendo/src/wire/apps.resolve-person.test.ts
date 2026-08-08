import { VendoError, type AccessLevel, type Membership, type Principal, type RunContext } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { appRoutes } from "./apps.js";
import { dispatchRoutes, routeSegments, type WireContext, type WireDeps } from "./shared.js";

/**
 * Build contract §9.1 companion — POST /apps/:appId/grants/resolve, the Share
 * dialog's one question for the host: "who is this person I typed?".
 *
 * Two properties are load-bearing. It is OWNER-GATED, because an ungated
 * directory lookup is a user-enumeration oracle on the host's own tables. And
 * "not set up" and "nobody by that name" are DIFFERENT answers, because the
 * dialog says different things about them and one of them must never offer to
 * share with a person at all.
 */

const ctxFor = (memberships: Membership[]): RunContext => ({
  principal: { kind: "user", subject: "dana", display: "Dana Vega" },
  venue: "app",
  presence: "present",
  sessionId: "s_dana",
  memberships,
});

/** One asserted org is the ordinary case; [] is the caller who could never
    complete the share the lookup exists for. */
const IN_ONE_ORG: Membership[] = [{ org: "maple", display: "Maple Bank" }];

const resolveWire = (options: {
  level: AccessLevel | null;
  query?: unknown;
  memberships?: Membership[];
  resolvePerson?: (query: string, asker: Principal) => Promise<{ subject: string; display?: string } | null>;
}): { wire: WireContext; asked: Array<{ query: string; asker: Principal }> } => {
  const asked: Array<{ query: string; asker: Principal }> = [];
  const url = new URL("https://maple.test/api/vendo/apps/app_1/grants/resolve");
  const path = url.pathname.slice("/api/vendo".length);
  const deps = {
    apps: { access: { async levelFor() { return options.level; } } },
    ...(options.resolvePerson === undefined ? {} : {
      resolvePerson: async (query: string, asker: Principal) => {
        asked.push({ query, asker });
        return await options.resolvePerson!(query, asker);
      },
    }),
  } as unknown as WireDeps;
  return {
    asked,
    wire: {
      request: new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: options.query ?? "mia" }),
      }),
      url,
      path,
      segments: routeSegments(path),
      params: { appId: "app_1" },
      context: async () => ctxFor(options.memberships ?? IN_ONE_ORG),
      // Only `/tick` sweeps (wire/misc.ts); no route under test calls it.
      sweep: async () => {},
      deps,
    },
  };
};

const known = async (query: string): Promise<{ subject: string; display?: string } | null> =>
  query.includes("mia") ? { subject: "maple-mia", display: "Mia Nakamura" } : null;

describe("§9.1 companion — the host names the person, and only for an owner", () => {
  it("answers the host's own subject and display name, never the typed string", async () => {
    const { wire, asked } = resolveWire({ level: "owner", resolvePerson: known });
    const answer = await dispatchRoutes(appRoutes, wire);
    expect(answer?.status).toBe(200);
    expect(await answer?.json()).toEqual({ person: { subject: "maple-mia", display: "Mia Nakamura" } });
    expect(asked.map((call) => call.query)).toEqual(["mia"]);
  });

  it("answers `person: null` for a name the host does not know — a real answer, not a failure", async () => {
    const { wire } = resolveWire({ level: "owner", query: "someone else", resolvePerson: known });
    const answer = await dispatchRoutes(appRoutes, wire);
    expect(answer?.status).toBe(200);
    expect(await answer?.json()).toEqual({ person: null });
  });

  it("is not-implemented when the host wired no directory — distinct from `nobody by that name`", async () => {
    const { wire } = resolveWire({ level: "owner" });
    await expect(dispatchRoutes(appRoutes, wire)).rejects.toMatchObject({ code: "not-implemented" });
  });

  it("refuses a caller who is not an owner, and never asks the host", async () => {
    // Anyone who can look up people can enumerate the host's directory. Only
    // someone who could actually write the grant gets to ask.
    for (const level of ["viewer", "editor"] as const) {
      const { wire, asked } = resolveWire({ level, resolvePerson: known });
      await expect(dispatchRoutes(appRoutes, wire)).rejects.toMatchObject({ code: "forbidden" });
      expect(asked).toEqual([]);
    }
  });

  it("masks the app for a caller who cannot even see it", async () => {
    const { wire, asked } = resolveWire({ level: null, resolvePerson: known });
    await expect(dispatchRoutes(appRoutes, wire)).rejects.toMatchObject({ code: "not-found" });
    expect(asked).toEqual([]);
  });

  it("hands the host the ASKER, not just the query", async () => {
    // Without it a host cannot implement the only scoping that matters — "only
    // resolve people in the asker's own org" — because it is never told who is
    // asking. Same reason `memberships` is keyed on Principal.
    const { wire, asked } = resolveWire({ level: "owner", resolvePerson: known });
    await dispatchRoutes(appRoutes, wire);
    expect(asked).toEqual([{
      query: "mia",
      asker: { kind: "user", subject: "dana", display: "Dana Vega" },
    }]);
  });

  it("refuses a caller who is in NO org, and never asks the host", async () => {
    // A caller with no asserted membership can never complete the share the
    // lookup exists for (a person-share implies an org workspace, §9.5), so
    // answering them is pure directory exposure: a signed-in stranger probing
    // from their own personal app was handed the host's real subjects and
    // display names, at HTTP 200.
    const { wire, asked } = resolveWire({ level: "owner", memberships: [], resolvePerson: known });
    await expect(dispatchRoutes(appRoutes, wire)).rejects.toMatchObject({ code: "forbidden" });
    expect(asked).toEqual([]);
  });

  it("refuses a query that is not a string", async () => {
    const { wire } = resolveWire({ level: "owner", query: 7, resolvePerson: known });
    await expect(dispatchRoutes(appRoutes, wire)).rejects.toBeInstanceOf(VendoError);
  });
});
