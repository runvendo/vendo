import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";

for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("round-trips exact bytes and content type, then deletes", async () => {
      const blobs = made.store.blobs("files");
      const bytes = new Uint8Array(randomBytes(257));
      await blobs.put("random.bin", bytes, { contentType: "application/octet-stream" });
      const found = await blobs.get("random.bin");
      expect(found?.contentType).toBe("application/octet-stream");
      expect(found?.bytes).toEqual(bytes);
      await blobs.delete("random.bin");
      expect(await blobs.get("random.bin")).toBeNull();
    });

    it("lists literal prefixes containing SQL LIKE metacharacters", async () => {
      const blobs = made.store.blobs("prefixes");
      for (const key of ["sales%/a", "sales%/b", "salesX/c", "under_/a", "underX/b"]) {
        await blobs.put(key, new Uint8Array([1]));
      }
      expect(await blobs.list("sales%/")).toEqual(["sales%/a", "sales%/b"]);
      expect(await blobs.list("under_/" )).toEqual(["under_/a"]);
    });

    it("isolates namespaces", async () => {
      await made.store.blobs("space_a").put("same", new Uint8Array([1]));
      await made.store.blobs("space_b").put("same", new Uint8Array([2]));
      expect((await made.store.blobs("space_a").get("same"))?.bytes).toEqual(new Uint8Array([1]));
      expect((await made.store.blobs("space_b").get("same"))?.bytes).toEqual(new Uint8Array([2]));
    });
  });
}
