import { describe, it, expect } from "vitest";
import type { UINode } from "@flowlet/core";
import { createLocalStore } from "./store";

const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };

describe("createLocalStore", () => {
  it("saves and lists flowlets", async () => {
    const store = createLocalStore();
    const saved = await store.save({ id: "f1", name: "Spending", node });
    expect(saved.name).toBe("Spending");
    expect(typeof saved.updatedAt).toBe("number");
    expect(await store.list()).toHaveLength(1);
  });

  it("loads by id and removes", async () => {
    const store = createLocalStore();
    await store.save({ id: "f1", name: "Spending", node });
    expect((await store.load("f1"))?.name).toBe("Spending");
    await store.remove("f1");
    expect(await store.load("f1")).toBeNull();
  });

  it("seeds from initial flowlets", async () => {
    const store = createLocalStore([{ id: "s", name: "Seed", node, updatedAt: 1 }]);
    expect(await store.list()).toHaveLength(1);
  });
});
