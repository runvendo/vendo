"use client";

/**
 * The shell's `VendoStore` seam backed by `createVendoHandler()`'s
 * `/vendos` endpoints (see ../vendos.ts). Chosen over `createWebStorage`
 * when the server reports the `storage` capability (durable storage is
 * wired) — see vendo-root.tsx.
 *
 * Same "failures are loud" contract as `createWebStorage`: an unreachable
 * server or a non-2xx response THROWS rather than silently no-op-ing.
 * Persistence must never fail quietly.
 */
import type { Vendo, VendoDraft, VendoStore } from "@vendoai/shell";

async function readJson<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`[vendo] ${action} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export function createServerVendoStore(basePath: string): VendoStore {
  return {
    async list() {
      const res = await fetch(`${basePath}/vendos`, { cache: "no-store" });
      return readJson<Vendo[]>(res, "list vendos");
    },
    async load(id) {
      const res = await fetch(`${basePath}/vendos/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (res.status === 404) return null;
      return readJson<Vendo>(res, `load vendo "${id}"`);
    },
    async save(draft: VendoDraft) {
      const res = await fetch(`${basePath}/vendos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
        cache: "no-store",
      });
      return readJson<Vendo>(res, `save vendo "${draft.id}"`);
    },
    async remove(id) {
      const res = await fetch(`${basePath}/vendos/${encodeURIComponent(id)}/delete`, {
        method: "POST",
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`[vendo] remove vendo "${id}" failed: ${res.status}`);
      }
    },
  };
}
