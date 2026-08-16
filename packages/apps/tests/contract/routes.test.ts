import { describe, expect, it } from "vitest";
import {
  resolveVendoRoute,
  vendoRouteMapSchema,
  vendoRouteParams,
  type VendoRouteMap,
} from "../../src/contract/catalog.js";

const routes: VendoRouteMap = {
  home: { path: "/", description: "The dashboard." },
  account: { path: "/accounts/:id", description: "One account by id." },
};

describe("the host route registry", () => {
  it("parses the { name: { path, description } } shape", () => {
    expect(vendoRouteMapSchema.parse(routes)).toEqual(routes);
  });

  it("refuses an entry missing its description — the agent picks by description, not path", () => {
    expect(vendoRouteMapSchema.safeParse({ home: { path: "/" } }).success).toBe(false);
  });

  it("resolves a registered name to its path", () => {
    expect(resolveVendoRoute(routes, "home")).toEqual({ to: "home", path: "/" });
  });

  it("substitutes :params and carries them on the navigation", () => {
    expect(resolveVendoRoute(routes, "account", { id: "acc_1" }))
      .toEqual({ to: "account", path: "/accounts/acc_1", params: { id: "acc_1" } });
  });

  it("URL-encodes a param, so a value can never break out of the registered path", () => {
    expect(resolveVendoRoute(routes, "account", { id: "../../admin?x=1" })?.path)
      .toBe("/accounts/..%2F..%2Fadmin%3Fx%3D1");
  });

  it("REFUSES a name the host never registered", () => {
    expect(resolveVendoRoute(routes, "admin")).toBeUndefined();
    expect(resolveVendoRoute(routes, "https://evil.example")).toBeUndefined();
    expect(resolveVendoRoute({}, "home")).toBeUndefined();
  });

  it("REFUSES a route whose :param the link left unfilled, rather than shipping a broken path", () => {
    expect(resolveVendoRoute(routes, "account")).toBeUndefined();
    expect(resolveVendoRoute(routes, "account", { wrong: "acc_1" })).toBeUndefined();
  });
});

describe("a `:` inside a segment is a literal, not a parameter", () => {
  // A colon is legal in a path segment. Reading `/reports/2026:Q3` as taking a
  // `Q3` parameter made a perfectly good route unresolvable — dead link, refused
  // screen, and a blank advertised to the model that the host can never fill.
  const literal: VendoRouteMap = {
    quarter: { path: "/reports/2026:Q3", description: "The Q3 report." },
    mixed: { path: "/reports/2026:Q3/:sectionId", description: "One section of it." },
  };

  it("takes no parameters from a path that only carries a literal colon", () => {
    expect(vendoRouteParams("/reports/2026:Q3")).toEqual([]);
  });

  it("resolves such a path as itself, with no params needed", () => {
    expect(resolveVendoRoute(literal, "quarter")).toEqual({ to: "quarter", path: "/reports/2026:Q3" });
  });

  it("still reads the colon-prefixed SEGMENTS beside it", () => {
    expect(vendoRouteParams("/reports/2026:Q3/:sectionId")).toEqual(["sectionId"]);
    expect(resolveVendoRoute(literal, "mixed", { sectionId: "s_1" }))
      .toEqual({ to: "mixed", path: "/reports/2026:Q3/s_1", params: { sectionId: "s_1" } });
    // …and the real parameter is still required.
    expect(resolveVendoRoute(literal, "mixed")).toBeUndefined();
  });

  it("keeps the ordinary readings it always had", () => {
    expect(vendoRouteParams("/")).toEqual([]);
    expect(vendoRouteParams("/accounts")).toEqual([]);
    expect(vendoRouteParams("/accounts/:id")).toEqual(["id"]);
  });
});
