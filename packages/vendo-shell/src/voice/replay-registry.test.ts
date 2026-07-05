import { describe, expect, it } from "vitest";
import { createReplayRegistry } from "./replay-registry";

describe("replay registry", () => {
  it("replays registered tools and throws for unknown ones", async () => {
    const registry = createReplayRegistry();
    registry.register("listTransactions", async (input) => ({ echoed: input }));
    expect(registry.has("listTransactions")).toBe(true);
    expect(registry.has("createOrder")).toBe(false);
    await expect(registry.replay("listTransactions", { month: 3 })).resolves.toEqual({
      echoed: { month: 3 },
    });
    await expect(registry.replay("createOrder", {})).rejects.toThrow(/not in the replay registry/);
  });

  it("latest registration wins (idempotent re-register)", async () => {
    const registry = createReplayRegistry();
    registry.register("t", async () => 1);
    registry.register("t", async () => 2);
    await expect(registry.replay("t", {})).resolves.toBe(2);
  });

  it("unregisters only the executor that owns the current name", async () => {
    const registry = createReplayRegistry();
    const unregisterFirst = registry.register("t", async () => 1);
    const unregisterSecond = registry.register("t", async () => 2);

    unregisterFirst();
    expect(registry.has("t")).toBe(true);
    await expect(registry.replay("t", {})).resolves.toBe(2);

    unregisterSecond();
    expect(registry.has("t")).toBe(false);
    await expect(registry.replay("t", {})).rejects.toThrow(/not in the replay registry/);
  });
});
