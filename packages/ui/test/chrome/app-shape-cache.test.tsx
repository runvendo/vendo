// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIPayload } from "@vendoai/core";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoSlot } from "../../src/chrome/index.js";
import { rememberedShape, rememberShape, rememberSlotApp } from "../../src/chrome/app-shape-cache.js";
import { createWireServer } from "../wire-server.js";

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

/** The state one beat EARLIER than the skeleton: the placements read is still in
 *  flight, so nothing yet says whether this slot holds an app. Painting the
 *  empty-slot invite there tells a returning person "nothing is pinned here"
 *  about a slot that demonstrably has something pinned — a confident lie, which
 *  is worse than the vague wait it replaced. */
describe("a slot whose placement has not answered yet", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    window.localStorage.clear();
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  const invite = () => screen.queryByText(/this space builds itself/i);
  const slot = () => render(
    <VendoProvider client={client}><VendoSlot id="hero" /></VendoProvider>,
  );

  it("waits in the silhouette it held last time, never in the empty invite", async () => {
    rememberShape("app_1", spend);
    rememberSlotApp("hero", "app_1");
    // In flight for the whole test: the read never answers, so the slot is held
    // in exactly the window the defect lived in.
    vi.spyOn(client.apps, "placements").mockReturnValue(new Promise(() => undefined));

    const { container } = slot();
    await waitFor(() => expect(container.querySelector(".fl-slot-bones")).not.toBeNull());
    expect([...container.querySelectorAll(".fl-bone")].map(bone => bone.getAttribute("data-bone")))
      .toEqual(["line", "chart"]);
    expect(invite()).toBeNull();
  });

  it("falls back to the generic ghost when it has never held anything", async () => {
    vi.spyOn(client.apps, "placements").mockReturnValue(new Promise(() => undefined));

    const { container } = slot();
    await waitFor(() => expect(container.querySelector(".fl-skel-bars")).not.toBeNull());
    expect(container.querySelector(".fl-slot-bones")).toBeNull();
    expect(invite()).toBeNull();
  });

  // The control: the invite is held BACK, not broken. A slot the wire has
  // confirmed empty still invites.
  it("invites once the read confirms the slot really is empty", async () => {
    const { container } = slot();
    expect(await screen.findByText(/this space builds itself/i)).toBeTruthy();
    expect(container.querySelector(".fl-slot-bones")).toBeNull();
  });
});
