import { randomBytes } from "node:crypto";
import { storeOpsConformance } from "../../src/core/conformance/index.js";
import { describe, it } from "vitest";
import { backends, emptySharedStore, type Backend } from "../../src/store/backends.test-util.js";
import { createStore, createStoreOps } from "../../src/store/index.js";

/** `secrets.*` is encrypted at rest and fails CLOSED with no key, so a store
 *  built without one cannot serve that family at all — and this suite asks for
 *  the whole contract. */
const encryption = { key: randomBytes(32).toString("base64") };

/** A store no other case has written to.
 *
 *  On PGlite that is the FILE's one engine with every table emptied: the kit
 *  calls this once per case, and 86 cases each booting an engine of their own
 *  was 78s of this file's 80. Postgres keeps `backend.make()`, which already
 *  carves a private schema per call for exactly the same reason — and there the
 *  store is re-made with the key, the same move the stored-SecretsProvider
 *  mount makes (tests/store/conformance.test.ts). Costs nothing: the handle is
 *  lazy, so the one it replaces never opened a database. */
const makeOpsOn = (backend: Backend) => async () => {
  if (backend.name === "pglite") return { ops: createStoreOps(await emptySharedStore({ encryption })) };
  const made = await backend.make();
  await made.store.close();
  made.store = createStore({ url: made.url, dataDir: made.dataDir, encryption });
  await made.store.ensureSchema();
  return { ops: createStoreOps(made.store), close: made.cleanup };
};

// The StoreOps contract, proven against the LOCAL backend (ops.ts) on both
// engines — the same suite the memory reference and the cloud client run.
for (const backend of backends()) {
  describe(`${backend.name} StoreOps conformance (local backend)`, () => {
    const suite = storeOpsConformance({ makeOps: makeOpsOn(backend) });
    // A pending case is carried but not run, and the reason rides in the test
    // name — the ops the contract declares and this backend does not serve yet
    // stay visible in the output instead of quietly not existing.
    for (const conformanceCase of suite.cases) {
      if (conformanceCase.pending === undefined) it(conformanceCase.name, conformanceCase.run);
      else it.skip(`${conformanceCase.name} [pending: ${conformanceCase.pending}]`, conformanceCase.run);
    }
  });
}
