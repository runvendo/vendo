import { describe, expect, it } from "vitest";
import {
  resolveVendoRoute,
  vendoRouteMapSchema,
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
