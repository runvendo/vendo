import { describe, it, expect, vi } from "vitest";
import type { UINode } from "@vendoai/core";
import { createWebStorage } from "./web-storage";

const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };

/** Minimal in-memory Storage (jsdom-free). */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe("createWebStorage", () => {
  it("round-trips a vendo and lists newest-first", async () => {
    let t = 0;
    const store = createWebStorage({ storage: fakeStorage(), now: () => ++t });
    await store.save({ id: "a", name: "A", node, prompt: "make A" });
    await store.save({ id: "b", name: "B", node });
    const list = await store.list();
    expect(list.map((f) => f.id)).toEqual(["b", "a"]);
    expect((await store.load("a"))?.prompt).toBe("make A");
  });

  it("keeps createdAt across rename saves and removes cleanly", async () => {
    let t = 0;
    const store = createWebStorage({ storage: fakeStorage(), now: () => ++t });
    const first = await store.save({ id: "a", name: "A", node });
    const renamed = await store.save({ id: "a", name: "A2", node });
    expect(renamed.createdAt).toBe(first.createdAt);
    expect(renamed.updatedAt).toBeGreaterThan(first.updatedAt);
    await store.remove("a");
    expect(await store.load("a")).toBeNull();
  });

  it("isolates namespaces over the same storage", async () => {
    const storage = fakeStorage();
    const s1 = createWebStorage({ storage, namespace: "u1" });
    const s2 = createWebStorage({ storage, namespace: "u2" });
    await s1.save({ id: "a", name: "A", node });
    expect(await s2.list()).toHaveLength(0);
    expect(await s1.list()).toHaveLength(1);
  });

  it("skips malformed records with a warning, and lets quota errors throw", async () => {
    const storage = fakeStorage();
    storage.setItem("vendo:saved:default:bad", "{not json");
    const store = createWebStorage({ storage });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await store.list()).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();

    const full: Storage = { ...fakeStorage(), setItem: () => { throw new Error("QuotaExceeded"); } };
    const failing = createWebStorage({ storage: full });
    await expect(failing.save({ id: "x", name: "X", node })).rejects.toThrow(/Quota/);
  });

  it("writes a versioned envelope, reads legacy bare records, skips unknown versions", async () => {
    const storage = fakeStorage();
    const store = createWebStorage({ storage });
    await store.save({ id: "a", name: "A", node });
    expect(JSON.parse(storage.getItem("vendo:saved:default:a")!).v).toBe(1);

    // Legacy bare record (pre-envelope) still reads as schema v1.
    storage.setItem("vendo:saved:default:legacy", JSON.stringify({ id: "legacy", name: "L", node, updatedAt: 1 }));
    expect((await store.load("legacy"))?.name).toBe("L");

    // A future schema version is skipped with a warning, not mis-parsed.
    storage.setItem("vendo:saved:default:future", JSON.stringify({ v: 99, record: { id: "future" } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await store.load("future")).toBeNull();
    expect(await store.list()).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown schema v99"));
    warn.mockRestore();
  });

  it("throws a clear error when no storage exists (SSR)", async () => {
    vi.stubGlobal("localStorage", undefined);
    try {
      const store = createWebStorage();
      await expect(store.list()).rejects.toThrow(/web storage unavailable/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
