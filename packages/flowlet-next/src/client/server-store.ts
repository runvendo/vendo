"use client";

/**
 * The shell's `FlowletStore` seam backed by `createFlowletHandler()`'s
 * `/flowlets` endpoints (see ../flowlets.ts). Chosen over `createWebStorage`
 * when the server reports the `storage` capability (durable storage is
 * wired) — see flowlet-root.tsx.
 *
 * Same "failures are loud" contract as `createWebStorage`: an unreachable
 * server or a non-2xx response THROWS rather than silently no-op-ing.
 * Persistence must never fail quietly.
 */
import type { Flowlet, FlowletDraft, FlowletStore } from "@flowlet/shell";

async function readJson<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`[flowlet] ${action} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export function createServerFlowletStore(basePath: string): FlowletStore {
  return {
    async list() {
      const res = await fetch(`${basePath}/flowlets`, { cache: "no-store" });
      return readJson<Flowlet[]>(res, "list flowlets");
    },
    async load(id) {
      const res = await fetch(`${basePath}/flowlets/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (res.status === 404) return null;
      return readJson<Flowlet>(res, `load flowlet "${id}"`);
    },
    async save(draft: FlowletDraft) {
      const res = await fetch(`${basePath}/flowlets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
        cache: "no-store",
      });
      return readJson<Flowlet>(res, `save flowlet "${draft.id}"`);
    },
    async remove(id) {
      const res = await fetch(`${basePath}/flowlets/${encodeURIComponent(id)}/delete`, {
        method: "POST",
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`[flowlet] remove flowlet "${id}" failed: ${res.status}`);
      }
    },
  };
}
