import { describe, expect, it, vi } from "vitest";

// speed-core lane — same guard as demo-bank: the demo must actually exercise
// the fast generation path, so the pipeline flags can never silently regress
// to the slow defaults.
const createVendoSpy = vi.hoisted(() => vi.fn(() => ({ __mock: "vendo" })));
vi.mock("@vendoai/vendo/server", () => ({
  createVendo: createVendoSpy,
  vendoModel: vi.fn(() => ({ __mock: "model" })),
}));

describe("Cadence vendo server config (speed-core)", () => {
  it("builds with the AMENDED demo pipeline (speed-core ruling): endPass on, regionParallel OFF", async () => {
    await import("./server");
    expect(createVendoSpy).toHaveBeenCalledTimes(1);
    const config = createVendoSpy.mock.calls[0]![0] as { apps?: { pipeline?: Record<string, unknown> } };
    expect(config.apps?.pipeline).toMatchObject({ endPass: true });
    // The rejected config (live evidence: speed-core after.md) must not creep back.
    expect(config.apps?.pipeline?.["regionParallel"]).toBeUndefined();
  }, 60_000); // the server module's import graph (umbrella + blocks) costs seconds cold
});
