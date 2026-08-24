/**
 * Erasing one conversation's files: the rows, their history, and the blobs those
 * rows were the only pointer to. The blob half is the point — a `rm` through the
 * façade leaves the object behind, because history is append-only.
 */
import type { FilesAdapter, Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { eraseStore } from "../src/erase.js";
import { workspaceStore } from "../src/workspace.js";

const user: Principal = { kind: "user", subject: "user_erase_thread" };
/** Past the inline cap, so the content lands behind the files adapter and the
    row carries a `blob_ref` — which is the whole thing being proved. */
const BIG = new Uint8Array(200_000).fill(7);

function bucket(): FilesAdapter & { keys: () => string[] } {
  const blobs = new Map<string, Uint8Array>();
  return {
    put: async (key, value) => void blobs.set(key, value),
    get: async (key) => {
      const value = blobs.get(key);
      return value === undefined ? undefined : { bytes: value };
    },
    delete: async (key) => void blobs.delete(key),
    keys: () => [...blobs.keys()],
  };
}

for (const backend of backends()) {
  describe(`${backend.name} erase.byThread`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("destroys a thread's files, their history and their blobs — and nothing else", async () => {
      const files = bucket();
      const workspace = workspaceStore(made.store, { files });
      const seed = await workspace.open(user);
      await seed.writeFile("/user/threads/thr_gone/files/scan.pdf", BIG);
      await seed.writeFile("/user/threads/thr_kept/files/scan.pdf", BIG);
      await seed.writeFile("/user/files/shelf.csv", "jan,31000\n");
      await seed.commit();
      // A second revision, so there is a history row holding a blob too.
      const again = await workspace.open(user);
      await again.writeFile("/user/threads/thr_gone/files/scan.pdf", new Uint8Array(200_000).fill(9));
      await again.commit();
      expect(files.keys().length).toBeGreaterThanOrEqual(3);

      const report = await eraseStore(made.store, { files }).byThread("thr_gone");

      expect(report.vendo_workspace_files).toBe(1);
      expect(report.vendo_workspace_history).toBeGreaterThanOrEqual(1);
      // The other conversation and the shelf are untouched.
      const after = await workspace.open(user);
      expect(await after.exists("/user/threads/thr_gone/files/scan.pdf")).toBe(false);
      expect(await after.exists("/user/threads/thr_kept/files/scan.pdf")).toBe(true);
      expect(await after.readFile("/user/files/shelf.csv")).toBe("jan,31000\n");
      // And exactly one blob survives: the other thread's.
      expect(files.keys()).toHaveLength(1);
    });
  });
}
