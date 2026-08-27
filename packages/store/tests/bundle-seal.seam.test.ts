/**
 * The sealed bundle, end to end through REAL paths.
 *
 * A seal has two halves in two packages: `@vendoai/apps` decides the keys and
 * the row, the store holds the bytes and arbitrates the row's revision. A suite
 * that hand-rolled either half could only ever agree with itself, so everything
 * below writes through the real writers (`sealBundleBlobs`, `updateAppRow`,
 * `createAppHistory`) over a real store and reads back through the real reader
 * (`readBundleBlob`) — no stand-in on either side.
 *
 * Two promises are on trial. That a blob key is the CONTENT's hash, so a reseal
 * can never overwrite bytes an open tab is still rendering. And that versioning
 * needs ZERO new code: the bounded CAS in `updateAppRow` plus the capped history
 * already give last-CAS-wins with the loser kept as a readable version.
 */
import { createAppHistory, readBundleBlob, sealBundleBlobs, updateAppRow } from "@vendoai/apps";
import { appBundleSchema, type AppDocument, type AppId } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { storeFiles } from "../src/files-store.js";
import { appFixture, persistentPrincipal } from "../src/fixtures.test-util.js";
import { createStoreOps } from "../src/index.js";

const text = (source: string): Uint8Array => new TextEncoder().encode(source);
/** Bytes no string round-trip survives — the hash is over BYTES, not over text. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0xff, 0xfe, 0x00]);

for (const backend of backends()) {
  describe(`${backend.name} sealed bundles`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const blobsOf = () => storeFiles(made.store);

    const seedApp = async (appId: AppId): Promise<void> => {
      await made.store.records("vendo_apps").put({
        id: appId,
        data: { subject: persistentPrincipal.subject, enabled: true, doc: appFixture(appId) },
      });
    };

    const headOf = async (appId: AppId): Promise<AppDocument> =>
      ((await made.store.records("vendo_apps").get(appId))?.data as { doc: AppDocument }).doc;

    it("reads every sealed file back byte-identical, by its own hash", async () => {
      const appId = "app_seal_read" as AppId;
      const blobs = blobsOf();
      const entry = text("export const app = () => 'hi';\n");

      const bundle = await sealBundleBlobs(appId, [
        { path: "index.js", bytes: entry },
        { path: "logo.png", bytes: PNG },
      ], "index.js", blobs);

      expect(await readBundleBlob(appId, bundle.entry, blobs)).toEqual(entry);
      expect(await readBundleBlob(appId, bundle.assets?.["logo.png"] ?? "", blobs)).toEqual(PNG);
      expect(await readBundleBlob(appId, "0".repeat(64), blobs)).toBeNull();
      expect(appBundleSchema.parse(bundle)).toEqual(bundle);
      expect(bundle.bytes).toBe(entry.byteLength + PNG.byteLength);
    });

    it("refuses a seal whose entry is not one of the built files", async () => {
      await expect(sealBundleBlobs(
        "app_seal_no_entry" as AppId,
        [{ path: "index.js", bytes: text("x\n") }],
        "main.js",
        blobsOf(),
      )).rejects.toThrow(/not among/);
    });

    it("keys by content, so a reseal mints a new key and leaves the old bytes readable", async () => {
      const appId = "app_seal_reseal" as AppId;
      const blobs = blobsOf();
      const first = text("v1\n");
      const second = text("v2\n");

      const before = await sealBundleBlobs(appId, [{ path: "index.js", bytes: first }], "index.js", blobs);
      const after = await sealBundleBlobs(appId, [{ path: "index.js", bytes: second }], "index.js", blobs);

      expect(after.entry).not.toBe(before.entry);
      expect(await readBundleBlob(appId, before.entry, blobs)).toEqual(first);
      expect(await readBundleBlob(appId, after.entry, blobs)).toEqual(second);
    });

    it("two concurrent seals: last CAS wins the head, the loser survives as a version", async () => {
      const appId = "app_seal_race" as AppId;
      await seedApp(appId);
      const blobs = blobsOf();
      const engine = createStoreOps(made.store).engine;
      const history = createAppHistory(engine);

      const seal = async (source: string) => {
        const bundle = await sealBundleBlobs(
          appId,
          [{ path: "index.js", bytes: text(source) }],
          "index.js",
          blobs,
        );
        const sealed = await updateAppRow(engine, appId, (doc) => ({ ...doc, ui: "bundle", bundle }), "box");
        await history.append(appId, sealed, { at: bundle.sealedAt, intent: source, rung: 3 });
        return bundle;
      };

      const [a, b] = await Promise.all([seal("A\n"), seal("B\n")]);

      const head = await headOf(appId);
      expect([a.entry, b.entry]).toContain(head.bundle?.entry);
      const loser = head.bundle?.entry === a.entry ? b : a;
      expect((await history.documents(appId)).map((doc) => doc.bundle?.entry)).toContain(loser.entry);
      expect(await readBundleBlob(appId, a.entry, blobs)).toEqual(text("A\n"));
      expect(await readBundleBlob(appId, b.entry, blobs)).toEqual(text("B\n"));
    });
  });
}
