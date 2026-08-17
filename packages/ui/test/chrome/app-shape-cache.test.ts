// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { UIPayload } from "@vendoai/core";
import { rememberedShape, rememberShape } from "../../src/chrome/app-shape-cache.js";

const payload = (nodes: Array<{ id: string; component: string; children?: string[] }>): UIPayload =>
  ({ formatVersion: "vendo-genui/v2", root: nodes[0]!.id, nodes }) as unknown as UIPayload;

const spend = payload([
  { id: "r", component: "Stack", children: ["t", "c"] },
  { id: "t", component: "Text" },
  { id: "c", component: "SpendChart" },
]);

describe("app shape cache (S2 — the silhouette a slot waits in)", () => {
  beforeEach(() => window.localStorage.clear());

  it("has nothing to draw before the app has ever been served", () => {
    expect(rememberedShape("app_1")).toBeUndefined();
  });

  it("captures the served tree's bones — layout only, containers transparent", () => {
    rememberShape("app_1", spend);
    expect(rememberedShape("app_1")).toEqual([{ kind: "line" }, { kind: "chart" }]);
    expect(window.localStorage.getItem("vendo:app-shape:app_1")).not.toBeNull();
  });

  it("replaces the silhouette when the app's version changes, and only then", () => {
    rememberShape("app_1", spend);
    const stamped = window.localStorage.getItem("vendo:app-shape:app_1");

    // Same tree again: the same version, so nothing is rewritten.
    rememberShape("app_1", spend);
    expect(window.localStorage.getItem("vendo:app-shape:app_1")).toBe(stamped);

    // An edit — the chart became a list and a badge joined it.
    rememberShape("app_1", payload([
      { id: "r", component: "Stack", children: ["t", "c", "b"] },
      { id: "t", component: "Text" },
      { id: "c", component: "TransactionList" },
      { id: "b", component: "StatusBadge" },
    ]));
    expect(rememberedShape("app_1")).toEqual([{ kind: "line" }, { kind: "rows" }, { kind: "pill" }]);
    expect(JSON.parse(window.localStorage.getItem("vendo:app-shape:app_1")!).v)
      .not.toBe(JSON.parse(stamped!).v);
  });

  it("keeps one app's shape out of another's slot", () => {
    rememberShape("app_1", spend);
    expect(rememberedShape("app_2")).toBeUndefined();
  });
});
