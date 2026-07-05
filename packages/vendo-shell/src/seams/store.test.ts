import { describe, it, expect } from "vitest";
import type { UINode } from "@vendoai/core";
import { createLocalStore } from "./store";

const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };

describe("createLocalStore", () => {
  it("saves and lists vendos", async () => {
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

  it("carries prompt/pinned and stamps createdAt once", async () => {
    const store = createLocalStore();
    const first = await store.save({ id: "f1", name: "Spending", node, prompt: "show my spending", pinned: true });
    expect(first.prompt).toBe("show my spending");
    expect(first.pinned).toBe(true);
    expect(typeof first.createdAt).toBe("number");
    const { updatedAt: _drop, ...draft } = first;
    const renamed = await store.save({ ...draft, name: "Late-night spending" });
    expect(renamed.createdAt).toBe(first.createdAt); // rename keeps identity
    expect(renamed.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it("seeds from initial vendos", async () => {
    const store = createLocalStore([{ id: "s", name: "Seed", node, updatedAt: 1 }]);
    expect(await store.list()).toHaveLength(1);
  });
});
