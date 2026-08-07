// @vitest-environment node
// A slot renders on the server too; touching storage during that render is a
// crash, so both entry points answer honestly with no window at all.
import { describe, expect, it } from "vitest";
import { knownSlots, noteSlot } from "../src/slot-notes.js";

describe("slot notes on the server", () => {
  it("knows no slots and writes none", () => {
    expect(typeof window).toBe("undefined");
    expect(() => noteSlot({ id: "hero", label: "Hero" })).not.toThrow();
    expect(knownSlots()).toEqual([]);
  });
});
