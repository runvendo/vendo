/**
 * §9.2–§9.4 asserted on EVERY road `appAccess` can take, because the denial
 * posture is the part that may not vary.
 *
 * `appAccess` resolves its engine family as
 * `store.ops?.engine ?? engineOverAdapter(store)` (helpers/app-access.ts:63), so
 * one permission check has three possible roads beneath it: a hosted store's own
 * ops, the family over a store this package minted, and the family over a host's
 * BYO adapter. That the three behave identically was, until this file, an
 * INFERENCE from shared code — the door calls only get/list/put/delete, and
 * `engineOverAdapter` degrades only the verbs it never calls (`claim`,
 * `insertIfAbsent`, `compareAndSwap`). An inference is not an assertion, and the
 * stake is the difference between `not-found` and `forbidden`: a masked app and a
 * leaked one. Nobody may learn an app exists by changing which store is wired.
 *
 * So core's own `appAccessConformance` runs once per road. Reused rather than
 * rewritten on purpose: it asserts the CODES rather than merely that something was
 * refused (conformance/app-access.ts:139 — grant is owner-gated, a viewer
 * `forbidden` and a stranger masked; :153 — list masked from a non-viewer; :165 —
 * the grant → revoke round trip ending at no level), and it is the same table
 * every other implementation of `AppAccess` is held to. A hand-copied deny table
 * here would be a second spelling of one rule, free to drift from the first.
 *
 * Each road gets its OWN store. The suite mints app ids from a timestamp and a
 * per-suite counter, so two suites constructed in the same millisecond hand the
 * same id to two roads; sharing one database between them would let one road's
 * rows answer another road's question.
 */
import type { AccessLevel, AppId, StoreOps } from "@vendoai/core";
import { appAccessConformance, memoryStoreAdapter } from "@vendoai/core/conformance";
import { afterAll, beforeAll, describe, it } from "vitest";
import { appFixture } from "../src/fixtures.test-util.js";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { appAccess } from "../src/helpers/app-access.js";
import { appStore } from "../src/helpers/apps.js";
import { createStoreOps } from "../src/ops.js";
import type { VendoStore } from "../src/store.js";

/** Not a handle `@vendoai/store` minted — the shape a hosted store presents.
 *  `records()` throws, so the façade cannot serve this road by accident. */
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

/** The org the conformance suite seeds its shared-app cases under. */
const SEED_ORG = "conformance-org";

/** A grant row put in place WITHOUT the owner gate — the suite's way of setting a
 *  world up before asserting the gate itself through `access.grant`. */
const grantRow = (appId: AppId, principal: string, level: AccessLevel) => ({
  id: `ag_${appId}_${principal}`,
  data: { appId, orgId: SEED_ORG, principal, level, createdBy: "seed" },
});

const ROADS = [
  "hosted ops — store.ops.engine",
  "local fallback — engineOverAdapter over a minted store",
  "BYO fallback — engineOverAdapter over a generic adapter",
] as const;

/** The store under test, plus the SQL handle to seed it through when it has one.
 *  A road with no handle seeds through its own generic record doors. */
interface Road {
  store: VendoStore;
  sql?: MadeBackend;
}

for (const backend of backends()) {
  describe(`${backend.name} build contract §9 — the same posture on every road`, () => {
    let local: MadeBackend;
    let hostedBacking: MadeBackend;
    let hosted: VendoStore;
    let byo: VendoStore;

    beforeAll(async () => {
      local = await backend.make();
      await local.store.ensureSchema();
      hostedBacking = await backend.make();
      await hostedBacking.store.ensureSchema();
      hosted = opsOnlyStore(createStoreOps(hostedBacking.store));
      const adapter = memoryStoreAdapter();
      await adapter.ensureSchema();
      byo = adapter as unknown as VendoStore;
    });
    afterAll(async () => {
      if (local) await local.cleanup();
      if (hostedBacking) await hostedBacking.cleanup();
    });

    /** Resolved per call, never at collect time: the handles above exist only
     *  once `beforeAll` has run. */
    const roadFor = (name: typeof ROADS[number]): Road => {
      switch (name) {
        case "hosted ops — store.ops.engine":
          return { store: hosted, sql: hostedBacking };
        case "local fallback — engineOverAdapter over a minted store":
          return { store: local.store, sql: local };
        case "BYO fallback — engineOverAdapter over a generic adapter":
          return { store: byo };
      }
    };

    for (const name of ROADS) {
      describe(name, () => {
        const suite = appAccessConformance({
          get access() { return appAccess(roadFor(name).store); },

          /** Seeding rides each road's OWN doors — the façade survives for exactly
           *  this kind of caller. */
          async seedApp(appId, subject) {
            const road = roadFor(name);
            if (road.sql !== undefined) {
              await appStore(road.sql.store).put({ kind: "user", subject }, appFixture(appId));
              return;
            }
            await road.store.records("vendo_apps").put({
              id: appId,
              data: { subject, enabled: true, doc: appFixture(appId) },
            });
          },

          /** On the SQL roads the routed door derives a grant's refs from its own
           *  columns. A generic adapter cannot: it keeps only the refs it is
           *  given, so this seeder passes the `app_id` the door lists by — the same
           *  invariant `appAccess.grant` itself observes (app-access.ts:216). A
           *  seeder that omitted it would write a grant nothing reads back, and the
           *  road would then fail for the seeding's reason rather than the door's. */
          async seedGrant(appId, principal, level) {
            const road = roadFor(name);
            const row = grantRow(appId, principal, level);
            if (road.sql !== undefined) {
              await road.sql.store.records("vendo_app_grants").put(row);
              return;
            }
            await road.store.records("vendo_app_grants").put({
              ...row,
              refs: { app_id: appId, principal, level },
            });
          },
        });
        for (const conformanceCase of suite.cases) it(conformanceCase.name, conformanceCase.run);
      });
    }
  });
}
