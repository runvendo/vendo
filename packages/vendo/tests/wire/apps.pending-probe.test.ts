import { VendoError, type AccessLevel, type RunContext } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { appRoutes } from "../../src/wire/apps.js";
import { dispatchRoutes, routeSegments, type WireContext, type WireDeps } from "../../src/wire/shared.js";

/**
 * Build contract §9.4 — existence-masking is not defeated by a query flag.
 * `?pending=1` turns the embed's expected pre-servable miss into a quiet 200,
 * and behind it sat an UNSCOPED `vendo_apps.get`: a stranger with no grant and
 * no membership was told a team app EXISTS (in a developer-voice sentence),
 * while the same request WITHOUT the flag correctly 404'd.
 */

const ctx: RunContext = {
  principal: { kind: "user", subject: "kim" },
  venue: "app",
  presence: "present",
  sessionId: "s_kim",
};

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
