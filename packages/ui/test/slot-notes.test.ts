// @vitest-environment jsdom
// The picker's destinations. A slot id is the HOST's markup — no Vendo record
// carries it — so a mounted VendoSlot noting itself is the only way a surface
// on another page can offer that slot at all. Origin-scoped localStorage, the
// same storage law as chrome/discoverability.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { knownSlots, noteSlot } from "../src/slot-notes.js";

describe("slot notes", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("knows nothing before a slot mounts", () => {
    expect(knownSlots()).toEqual([]);
  });

  it("records a slot and reads it back", () => {
    noteSlot({ id: "hero", label: "Hero" });
    expect(knownSlots()).toEqual([{ id: "hero", label: "Hero" }]);
  });

  it("keeps first-seen order and never duplicates an id", () => {
    noteSlot({ id: "hero", label: "Hero" });
    noteSlot({ id: "net-worth", label: "Net worth" });
    noteSlot({ id: "hero", label: "Hero" });
    expect(knownSlots().map(note => note.id)).toEqual(["hero", "net-worth"]);
  });

  it("updates a label in place when the same slot mounts with a new one", () => {
    noteSlot({ id: "hero", label: "Hero" });
    noteSlot({ id: "hero", label: "Home hero" });
    expect(knownSlots()).toEqual([{ id: "hero", label: "Home hero" }]);
  });

  it("survives a value another tool wrote under the key", () => {
    window.localStorage.setItem("vendo.slots", "{not json");
    expect(knownSlots()).toEqual([]);
    noteSlot({ id: "hero", label: "Hero" });
    expect(knownSlots()).toEqual([{ id: "hero", label: "Hero" }]);
  });

  it("drops entries that are not slot notes rather than handing them to the picker", () => {
    window.localStorage.setItem("vendo.slots", JSON.stringify([{ id: "hero" }, 7, { id: "ok", label: "Ok" }]));
    expect(knownSlots()).toEqual([{ id: "ok", label: "Ok" }]);
  });

  it("does not throw when storage refuses the write (quota, private mode)", () => {
    // Storage.prototype, not the instance: jsdom's localStorage is a Proxy and
    // spying the instance property does not stick.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => noteSlot({ id: "hero", label: "Hero" })).not.toThrow();
  });
});
