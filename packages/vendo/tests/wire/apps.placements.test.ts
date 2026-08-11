import type { RunContext } from "@vendoai/core";
import { createVendoClient } from "@vendoai/ui";
import { describe, expect, it } from "vitest";
import { appRoutes } from "../../src/wire/apps.js";
import { dispatchRoutes, routeSegments, type WireContext, type WireDeps } from "../../src/wire/shared.js";

/**
 * The placement routes, dispatched through the REAL route table — which is the
 * only way to prove the one thing that can silently break here: `/apps/placements`
 * has to be matched before the `/apps/:appId/*` catch-all, whose rest pattern
 * would otherwise resolve it as the app id "placements" (the same trap
 * /apps/seed and /apps/import sit in front of).
 */

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "s_ada",
};

interface Calls {
  placements: Array<{ slots?: readonly string[] }>;
  placed: Array<{ app: string; slot: string }>;
  unplaced: Array<{ app: string; slot: string }>;
  get: string[];
}

const wireFor = (url: string, init?: RequestInit): { wire: WireContext; calls: Calls } => {
  const calls: Calls = { placements: [], placed: [], unplaced: [], get: [] };
  const parsed = new URL(url);
  const path = parsed.pathname.slice("/api/vendo".length);
  const deps = {
    apps: {
      async placements(input: { slots?: readonly string[] }) {
        calls.placements.push(input);
        return [{ slot: "home-hero", app: "app_1", title: "Spending", status: "ready" }];
      },
      async place(input: { app: string; slot: string }) {
        calls.placed.push(input);
        return { evicted: "app_0" };
      },
      async unplace(input: { app: string; slot: string }) {
        calls.unplaced.push(input);
      },
      async get(appId: string) {
        calls.get.push(appId);
        return null;
      },
    },
  } as unknown as WireDeps;
  return {
    calls,
    wire: {
      request: new Request(parsed, init),
      url: parsed,
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

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("GET /apps/placements", () => {
  it("answers the caller's placements and never falls into the :appId catch-all", async () => {
    const { wire, calls } = wireFor("https://maple.test/api/vendo/apps/placements");
    const answer = await dispatchRoutes(appRoutes, wire);
    expect(answer?.status).toBe(200);
    expect(await answer?.json()).toEqual([
      { slot: "home-hero", app: "app_1", title: "Spending", status: "ready" },
    ]);
    expect(calls.placements).toEqual([{}]);
    // The catch-all would have looked the "app" up; nothing did.
    expect(calls.get).toEqual([]);
  });

  it("narrows to the slots the surface has mounted", async () => {
    const { wire, calls } = wireFor("https://maple.test/api/vendo/apps/placements?slots=home-hero%2Csidebar%2C%20");
    expect((await dispatchRoutes(appRoutes, wire))?.status).toBe(200);
    expect(calls.placements).toEqual([{ slots: ["home-hero", "sidebar"] }]);
  });

  // ADVERSARIAL (re-check round, 2026-08-06). BOTH halves are real here: the
  // shipped client builds the query string and the shipped route parses it.
  //
  // The client joins the mounted slot ids with "," and percent-encodes the
  // whole join (`client-impl.ts` — `encodeURIComponent(slots.join(","))`), so
  // the separator survives decoding as an ordinary comma; the route then splits
  // on "," (`apps.ts`). A slot id that itself contains a comma is therefore
  // writable — `place` takes any non-blank string — and unreadable: it comes
  // back as two slot names that do not exist, so the app is in a slot the page
  // can never resolve and the person sees an empty slot with no way to fix it.
  it("asks for the slot id the client was given, comma and all", async () => {
    let asked: string | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await createVendoClient({ baseUrl: "https://maple.test/api/vendo" }).apps.placements(["sales,eu"]);
    } finally {
      globalThis.fetch = realFetch;
    }

    const { wire, calls } = wireFor(asked!);
    expect((await dispatchRoutes(appRoutes, wire))?.status).toBe(200);
    expect(calls.placements).toEqual([{ slots: ["sales,eu"] }]);
  });
});

describe("POST /apps/:id/place and /unplace", () => {
  it("places and reports the evicted app", async () => {
    const { wire, calls } = wireFor(
      "https://maple.test/api/vendo/apps/app_1/place",
      postJson({ slot: "home-hero" }),
    );
    const answer = await dispatchRoutes(appRoutes, wire);
    expect(answer?.status).toBe(200);
    expect(await answer?.json()).toEqual({ evicted: "app_0" });
    expect(calls.placed).toEqual([{ app: "app_1", slot: "home-hero" }]);
  });

  it("unplaces and answers empty", async () => {
    const { wire, calls } = wireFor(
      "https://maple.test/api/vendo/apps/app_1/unplace",
      postJson({ slot: "home-hero" }),
    );
    const answer = await dispatchRoutes(appRoutes, wire);
    expect(await answer?.json()).toEqual({});
    expect(calls.unplaced).toEqual([{ app: "app_1", slot: "home-hero" }]);
  });

  it("refuses a place with no slot", async () => {
    const { wire } = wireFor("https://maple.test/api/vendo/apps/app_1/place", postJson({}));
    await expect(dispatchRoutes(appRoutes, wire)).rejects.toMatchObject({ code: "validation" });
  });
});
