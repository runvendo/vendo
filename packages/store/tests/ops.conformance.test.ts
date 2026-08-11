import { storeOpsConformance } from "@vendoai/core/conformance";
import { describe, it } from "vitest";
import { backends } from "../src/backends.test-util.js";
import { createStoreOps } from "../src/index.js";

// The StoreOps contract, proven against the LOCAL backend (ops.ts) on both
// engines — the same suite the memory reference and the cloud client run.
for (const backend of backends()) {
  describe(`${backend.name} StoreOps conformance (local backend)`, () => {
    const suite = storeOpsConformance({
      async makeOps() {
        const made = await backend.make();
        await made.store.ensureSchema();
        return { ops: createStoreOps(made.store), close: made.cleanup };
      },
    });
    for (const conformanceCase of suite.cases) {
      it(conformanceCase.name, conformanceCase.run);
    }
  });
}
