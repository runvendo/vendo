/**
 * Build contract §9.2–§9.4 through the `engine` family, on a store that carries
 * its OWN ops and no SQL handle — the hosted shape, which is the shape every
 * multi-party deployment actually runs.
 *
 * `appAccess` reached its two drawers through `store.records(collection)`, the
 * generic door a HOST reaches its own rows through; it names them to
 * `ops.engine.*` now, so the allowlist stands in front of every read and write.
 * That move is invisible from the outside, which is why this suite is shaped to
 * be UNABLE to pass on the old road: `records()` throws here, and the ops behind
 * it are the real local backend over a real database. Every grant below is
 * written through the door's own write path and read back through its own read
 * path — and then once more straight out of `vendo_app_grants`, so the row a
 * caller resolves and the row on disk cannot disagree.
 *
 * The DENY half is the half that matters on permission code, so it is here in
 * full: a stranger stays masked, an editor cannot re-share, and a revoke leaves
 * nothing standing in either place.
 */
import type { Membership, RunContext, StoreOps } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appFixture } from "../src/fixtures.test-util.js";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { appAccess } from "../src/helpers/app-access.js";
import { appStore } from "../src/helpers/apps.js";
import { createStoreOps } from "../src/ops.js";
import type { VendoStore } from "../src/store.js";

const ctxFor = (subject: string, memberships?: Membership[]): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `s_${subject}`,
  ...(memberships === undefined ? {} : { memberships }),
});

/** Not a handle `@vendoai/store` minted — the shape a hosted store presents.
 *  `records()` throws: the façade survives for hosts, but this door may not be
 *  served by it any more, and a test that let it would prove nothing. */
function opsOnlyStore(ops: StoreOps): VendoStore {
  const unused = (what: string): never => {
    throw new Error(`the app-access door must not reach ${what}`);
  };
  return {
    ops,
    records: () => unused("records()"),
    blobs: () => unused("blobs()"),
    async ensureSchema() {},
    async close() {},
    raw: () => unused("raw()"),
  };
}

for (const backend of backends()) {
  describe(`${backend.name} build contract §9 — app access over ops.engine`, () => {
    let made: MadeBackend;
    let hosted: VendoStore;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
      // The SAME database, reached the way a store with no SQL handle reaches it.
      hosted = opsOnlyStore(createStoreOps(made.store));
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const access = (): ReturnType<typeof appAccess> => appAccess(hosted);
    /** The row as `vendo_app_grants` holds it, not as the door reports it. */
    const rowsFor = async (app: string): Promise<Record<string, unknown>[]> =>
      await made.sql("SELECT principal, level FROM vendo_app_grants WHERE app_id = $1", [app]);

    const admin = ctxFor("dana", [{ org: "acme", admin: true }]);

    it("writes a grant and resolves it back, with the row on disk agreeing", async () => {
      const app = "app_ops_grant";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, appFixture(app));

      await access().grant(admin, app, "user:kim", "editor");

      expect(await access().levelFor(ctxFor("kim"), app)).toBe("editor");
      expect(await access().can(ctxFor("kim"), "editor", { app })).toBe(true);
      expect(await access().list(admin, app)).toHaveLength(1);
      expect(await rowsFor(app)).toEqual([{ principal: "user:kim", level: "editor" }]);
    });

    // The red half of the gate: these MUST fail, and §9.4's two postures must
    // stay distinguishable — masked for someone who cannot see the app at all,
    // `forbidden` for a proven viewer reaching past their level.
    it("denies a stranger and an editor, and leaves nothing after a revoke", async () => {
      const app = "app_ops_deny";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, appFixture(app));
      await access().grant(admin, app, "user:kim", "editor");

      // A stranger: no level, no view, and existence stays masked.
      expect(await access().levelFor(ctxFor("mal"), app)).toBeNull();
      expect(await access().can(ctxFor("mal"), "viewer", { app })).toBe(false);
      await expect(access().list(ctxFor("mal"), app))
        .rejects.toMatchObject({ code: "not-found" });
      await expect(access().grant(ctxFor("mal"), app, "user:mal", "owner"))
        .rejects.toMatchObject({ code: "not-found" });
      // An editor sees the app, so re-sharing is refused as `forbidden`.
      await expect(access().grant(ctxFor("kim"), app, "user:mal", "viewer"))
        .rejects.toMatchObject({ code: "forbidden" });
      await expect(access().revoke(ctxFor("kim"), app, "user:kim"))
        .rejects.toMatchObject({ code: "forbidden" });
      // Nothing the refusals touched was written.
      expect(await rowsFor(app)).toEqual([{ principal: "user:kim", level: "editor" }]);

      await access().revoke(admin, app, "user:kim");
      expect(await access().levelFor(ctxFor("kim"), app)).toBeNull();
      expect(await rowsFor(app)).toEqual([]);
    });

    it("refuses a collection outside the engine allowlist, which is what the family adds", async () => {
      // The gate is the ONE statement this migration put in front of every verb.
      // Named here so the door's drawers staying inside the allowlist is a fact
      // this suite holds, not an accident of the two strings above.
      await expect(hosted.ops!.engine.get("invoices", "any"))
        .rejects.toMatchObject({ code: "blocked" });
    });
  });
}
