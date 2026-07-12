import { randomBytes } from "node:crypto";
import { secretsProviderConformance, storeAdapterConformance } from "@vendoai/core/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { createStore, envSecrets, secretStore, storeSecrets } from "./index.js";

it("explains how to initialize the store before raw access", async () => {
  const store = createStore({ dataDir: "memory://raw-before-open" });
  expect(() => store.raw()).toThrow(
    new Error("[vendo] store not opened yet — run ensureSchema() or any query first"),
  );
  await store.close();
});

for (const backend of backends()) {
  describe(backend.name, () => {
    describe("StoreAdapter conformance", () => {
      const suite = storeAdapterConformance({
        async makeAdapter() {
          const made = await backend.make();
          return { adapter: made.store, close: made.cleanup };
        },
      });
      for (const c of suite.cases) it(c.name, c.run);
    });

    describe("environment SecretsProvider conformance", () => {
      const presentName = "VENDO_CONFORMANCE_PRESENT";
      const absentName = "VENDO_CONFORMANCE_ABSENT";
      beforeAll(() => {
        process.env[presentName] = "environment-secret";
        delete process.env[absentName];
      });
      afterAll(() => {
        delete process.env[presentName];
        delete process.env[absentName];
      });
      const suite = secretsProviderConformance({
        async makeProvider() { return envSecrets(); },
        presentName,
        expectedValue: "environment-secret",
        absentName,
      });
      for (const c of suite.cases) it(c.name, c.run);
    });

    describe("stored SecretsProvider conformance", () => {
      let made: MadeBackend;
      const key = randomBytes(32).toString("base64");
      beforeAll(async () => {
        made = await backend.make();
        await made.store.close();
        made.store = createStore({ url: made.url, dataDir: made.dataDir, encryption: { key } });
        await made.store.ensureSchema();
        await secretStore(made.store).set("present_secret", "stored-secret");
      });
      afterAll(async () => { if (made) await made.cleanup(); });
      const suite = secretsProviderConformance({
        async makeProvider() { return storeSecrets(made.store); },
        presentName: "present_secret",
        expectedValue: "stored-secret",
        absentName: "absent_secret",
      });
      for (const c of suite.cases) it(c.name, c.run);
    });
  });
}
