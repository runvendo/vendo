import { describe, expect, it, vi } from "vitest";
import {
  createPageContextRegistry,
  AMBIENT_TOTAL_BYTES,
  MAX_ANCHORS,
  PER_ANCHOR_CONTEXT_BYTES,
} from "./page-context-registry";

describe("createPageContextRegistry", () => {
  it("registers, resolves, and deregisters anchors (mount lifecycle)", () => {
    const registry = createPageContextRegistry();
    const off = registry.register({ anchorId: "a1", label: "Invoices", context: { rows: 3 } });
    expect(registry.get("a1")?.label).toBe("Invoices");
    expect(registry.ambient()).toEqual([{ anchorId: "a1", label: "Invoices", context: { rows: 3 } }]);
    off();
    expect(registry.get("a1")).toBeUndefined();
    expect(registry.ambient()).toEqual([]);
  });

  it("duplicate id: last mount wins, one console warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createPageContextRegistry();
    registry.register({ anchorId: "a1", label: "First" });
    registry.register({ anchorId: "a1", label: "Second" });
    expect(registry.get("a1")?.label).toBe("Second");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/duplicate/i);
    warn.mockRestore();
  });

  it("caps the anchor count", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createPageContextRegistry();
    for (let i = 0; i < MAX_ANCHORS + 5; i++) registry.register({ anchorId: `a${i}` });
    expect(registry.ambient().length).toBe(MAX_ANCHORS);
    warn.mockRestore();
  });

  it("drops oversized per-anchor context and trims ambient total largest-first", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createPageContextRegistry();
    // Oversized single context: kept as an anchor, context dropped.
    registry.register({ anchorId: "big", context: { blob: "x".repeat(PER_ANCHOR_CONTEXT_BYTES + 1) } });
    expect(registry.ambient().find((a) => a.anchorId === "big")?.context).toBeUndefined();

    // Ambient total: fill with anchors that sum past the total cap; the
    // largest contexts are dropped first, the anchors themselves stay listed.
    const each = Math.floor(PER_ANCHOR_CONTEXT_BYTES * 0.9);
    const count = Math.ceil(AMBIENT_TOTAL_BYTES / each) + 2;
    for (let i = 0; i < count; i++) {
      registry.register({ anchorId: `c${i}`, context: { blob: "y".repeat(each) } });
    }
    const ambient = registry.ambient();
    const totalBytes = ambient.reduce(
      (sum, a) => sum + (a.context ? JSON.stringify(a.context).length : 0),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(AMBIENT_TOTAL_BYTES);
    expect(ambient.length).toBe(count + 1); // every anchor still listed
    warn.mockRestore();
  });

  it("never exposes snapshots ambiently", () => {
    const registry = createPageContextRegistry();
    registry.register({
      anchorId: "a1",
      label: "Invoices",
      getSnapshot: () => "<div>secret baseline</div>",
    });
    expect(JSON.stringify(registry.ambient())).not.toContain("secret baseline");
    // The snapshot IS reachable through the scoped path (explicit click).
    expect(registry.get("a1")?.getSnapshot?.()).toContain("secret baseline");
  });
});
