import { randomBytes } from "node:crypto";
import { storeOpsConformance } from "@vendoai/core/conformance";
import { describe, it } from "vitest";
import { backends } from "../src/backends.test-util.js";
import { createStore, createStoreOps } from "../src/index.js";

// The StoreOps contract, proven against the LOCAL backend (ops.ts) on both
// engines — the same suite the memory reference and the cloud client run.
for (const backend of backends()) {
  describe(`${backend.name} StoreOps conformance (local backend)`, () => {
    const suite = storeOpsConformance({
      async makeOps() {
        const made = await backend.make();
        // `secrets.*` is encrypted at rest and fails CLOSED with no key, so a
        // store built without one cannot serve that family at all — and this
        // suite asks for the whole contract. Re-made with a key, the same move
        // the stored-SecretsProvider mount makes (tests/conformance.test.ts).
        // Costs nothing: the handle is lazy, so the one it replaces never
        // opened a database.
        await made.store.close();
        made.store = createStore({
          url: made.url,
          dataDir: made.dataDir,
          encryption: { key: randomBytes(32).toString("base64") },
        });
        await made.store.ensureSchema();
        return { ops: createStoreOps(made.store), close: made.cleanup };
      },
    });
    // A pending case is carried but not run, and the reason rides in the test
    // name — the ops the contract declares and this backend does not serve yet
    // stay visible in the output instead of quietly not existing.
    for (const conformanceCase of suite.cases) {
      if (conformanceCase.pending === undefined) it(conformanceCase.name, conformanceCase.run);
      else it.skip(`${conformanceCase.name} [pending: ${conformanceCase.pending}]`, conformanceCase.run);
    }
  });
}
