import { VendoError, type AccessLevel, type RunContext } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { appRoutes } from "../../src/wire/apps.js";
import { dispatchRoutes, routeSegments, type WireContext, type WireDeps } from "../../src/wire/shared.js";

/**
 * Build contract §9.2–§9.4 — DELETE /apps/:appId/grants reads the grant list
 * back to answer, and that read is viewer-gated: removing your OWN last grant
 * legitimately loses you the right to read it. The masking is tolerated so a
 * removal that LANDED never reports failure — and nothing else is, which is what
 * these cases pin.
 *
 * The distinction matters on a Cloud-hosted store: `hosted-store.ts` carries a
 * misbehaving console's failure on a PLAIN Error with the server's code attached
 * (`Object.assign(new Error(message), { code })`), so matching on the code alone
 * would read "the console said not-found" as "the caller may no longer look".
 */

const ctx: RunContext = {
  principal: { kind: "user", subject: "kim" },
  venue: "app",
  presence: "present",
  sessionId: "s_kim",
};

const wireFor = (list: () => Promise<Array<{ id: string }>>): {
  wire: WireContext;
  revoked: string[];
} => {
  const revoked: string[] = [];
  const url = new URL("https://maple.test/api/vendo/apps/app_1/grants?principal=user%3Akim");
  const path = url.pathname.slice("/api/vendo".length);
  const deps = {
    apps: {
      access: {
        async revoke(_appId: string, principal: string) { revoked.push(principal); },
        list,
      },
    },
  } as unknown as WireDeps;
  return {
    revoked,
    wire: {
      request: new Request(url, { method: "DELETE" }),
      url,
      path,
      segments: routeSegments(path),
      params: {},
      context: async () => ctx,
      // Only `/tick` sweeps (wire/misc.ts); no route under test calls it.
      sweep: async () => {},
      deps,
    },
  };
};

describe("§9.4 — what the DELETE read-back may forgive", () => {
  it("answers the successful removal with an empty list when the caller may no longer read it", async () => {
    // The genuine masking path: `can()` refuses, as a VendoError, because kim
    // removed her own last grant. The removal happened — say so.
    const { wire, revoked } = wireFor(async () => {
      throw new VendoError("not-found", "app not found: app_1");
    });
    const answer = await dispatchRoutes(appRoutes, wire);
    expect(answer?.status).toBe(200);
    expect(await answer?.json()).toEqual({ grants: [] });
    expect(revoked).toEqual(["user:kim"]);
  });

  it("forgives a `forbidden` mask the same way", async () => {
    const { wire } = wireFor(async () => {
      throw new VendoError("forbidden", "viewer access is required for app_1");
    });
    expect((await dispatchRoutes(appRoutes, wire))?.status).toBe(200);
  });

  it("SURFACES a plain Error carrying code not-found — a misbehaving hosted store is not a mask", async () => {
    // Exactly what hosted-store.ts throws when the console answers badly. It is
    // not §9.4 speaking, so it must not be read as one: the caller hears it.
    const { wire } = wireFor(async () => {
      throw Object.assign(new Error("Vendo Cloud store returned an invalid response"), {
        code: "not-found",
      });
    });
    await expect(dispatchRoutes(appRoutes, wire)).rejects.toThrow("Vendo Cloud store");
  });

  it("surfaces every other failure, masked-looking or not", async () => {
    for (const failure of [
      Object.assign(new Error("console said forbidden"), { code: "forbidden" }),
      Object.assign(new Error("store unavailable"), { code: "unavailable" }),
      new Error("bare"),
      new VendoError("validation", "nonsense"),
    ]) {
      const { wire } = wireFor(async () => { throw failure; });
      await expect(dispatchRoutes(appRoutes, wire)).rejects.toBe(failure);
    }
  });

  it("hands back the remaining grants when the caller can still read them", async () => {
    const { wire } = wireFor(async () => [{ id: "ag_1" }]);
    const answer = await dispatchRoutes(appRoutes, wire);
    expect(await answer?.json()).toEqual({ grants: [{ id: "ag_1" }] });
  });
});

/**
 * Build contract §9.4 — existence-masking is not defeated by a query flag.
 * `?pending=1` turns the embed's expected pre-servable miss into a quiet 200,
 * and behind it sat an UNSCOPED `vendo_apps.get`: a stranger with no grant and
 * no membership was told a team app EXISTS (in a developer-voice sentence),
 * while the same request WITHOUT the flag correctly 404'd.
 */

const openWire = (options: {
  appId: string;
  /** What `can()` says about this caller — null is "cannot even view". */
  level: AccessLevel | null;
  /** The row an UNSCOPED read would find, if any. */
  record?: { data: unknown } | null;
}): WireContext => {
  const url = new URL(`https://maple.test/api/vendo/apps/${options.appId}/open?pending=1`);
  const path = url.pathname.slice("/api/vendo".length);
  const deps = {
    apps: {
      // Owner-scoped open() masks everything this caller may not serve.
      async open() { throw new VendoError("not-found", `app not found: ${options.appId}`); },
      access: { async levelFor() { return options.level; } },
    },
    store: {
      records: () => ({ async get() { return options.record ?? null; } }),
    },
  } as unknown as WireDeps;
  return {
    request: new Request(url),
    url,
    path,
    segments: routeSegments(path),
    params: { appId: options.appId },
    context: async () => ctx,
    // Only `/tick` sweeps (wire/misc.ts); no route under test calls it.
    sweep: async () => {},
    deps,
  };
};

const failedRecord = { data: { doc: { buildFailed: { reason: "the build timed out", retryable: false } } } };

describe("§9.4 — ?pending=1 is not an existence oracle", () => {
  it("answers a stranger IDENTICALLY for an app that exists and one that does not", async () => {
    const real = await dispatchRoutes(appRoutes, openWire({
      appId: "app_team",
      level: null,
      record: { data: { doc: { name: "Team dashboard" } } },
    }));
    const imaginary = await dispatchRoutes(appRoutes, openWire({ appId: "app_nope", level: null }));
    const [seen, unseen] = [await real?.json(), await imaginary?.json()];
    expect(real?.status).toBe(imaginary?.status);
    expect(seen).toEqual(unseen);
    expect(unseen).toEqual({ kind: "pending" });
  });

  it("does not leak a terminal build failure to a stranger either", async () => {
    // A failed build is still an existence proof, and the reason is content.
    const answer = await dispatchRoutes(appRoutes, openWire({
      appId: "app_team_failed",
      level: null,
      record: failedRecord,
    }));
    expect(await answer?.json()).toEqual({ kind: "pending" });
  });

  it("still runs the diagnostic for a caller who can already SEE the app", async () => {
    const answer = await dispatchRoutes(appRoutes, openWire({
      appId: "app_mine",
      level: "viewer",
      record: failedRecord,
    }));
    expect(await answer?.json()).toEqual({
      kind: "failed",
      reason: "the build timed out",
      retryable: false,
    });
  });

  it("keeps the principal-mismatch diagnosis for the HOST, in the server log, not in the payload", async () => {
    // The sentence names the wire route's principal wiring — a developer's
    // problem, in a developer's voice. It stays; it just stops being served to
    // whoever asked (0.4.1 E2E cert B4 kept its signal, the embed keeps its
    // masking).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const answer = await dispatchRoutes(appRoutes, openWire({
        appId: "app_mismatch",
        level: null,
        record: { data: { doc: { name: "Someone else's" } } },
      }));
      expect(await answer?.json()).toEqual({ kind: "pending" });
      expect(warn.mock.calls.flat().join(" ")).toMatch(/principal/i);
    } finally {
      warn.mockRestore();
    }
  });
});
