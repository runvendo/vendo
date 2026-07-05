import { describe, expect, it } from "vitest";
import { createWebRemixes } from "./web-remixes";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

const node = { id: "n1", kind: "generated" as const, payload: {} };

describe("createWebRemixes", () => {
  it("pins with upsert semantics and survives via storage", async () => {
    const storage = memoryStorage();
    let t = 100;
    const remixes = createWebRemixes({ storage, now: () => ++t });

    const first = await remixes.pin({ anchorId: "a1", node, prompt: "p" });
    expect(first.createdAt).toBe(101);

    const second = await remixes.pin({ anchorId: "a1", node: { ...node, id: "n2" } });
    expect(second.createdAt).toBe(101);
    expect(second.updatedAt).toBe(102);

    // A fresh client over the same storage sees the pin (reload survival).
    const reloaded = createWebRemixes({ storage, now: () => ++t });
    expect((await reloaded.get("a1"))?.node.id).toBe("n2");

    await reloaded.unpin("a1");
    expect(await remixes.get("a1")).toBeNull();
  });

  it("skips malformed records instead of throwing", async () => {
    const storage = memoryStorage();
    storage.setItem("flowlet:remix:default:a1", "{not json");
    const remixes = createWebRemixes({ storage });
    expect(await remixes.get("a1")).toBeNull();
  });
});
