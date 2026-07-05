/**
 * DrizzleConnectionsStore contract tests — a durable implementation of the
 * structural shape of @vendoai/next's `ConnectionsStore`
 * (packages/vendo-next/src/connections.ts), duck-typed locally in
 * @vendoai/store to avoid a next -> store -> next dependency cycle, plus the
 * two additions the webhook + integrations flow need: `setConnectedAccount`
 * and `findByConnectedAccount`.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Principal } from "@vendoai/core";
import { createVendoDatabase, migrateVendoDatabase, type VendoDb } from "./db.js";
import { createDrizzleConnectionsStore, type IntegrationCatalogEntry } from "./connections-store.js";

const scope: Principal = { tenantId: "t1", subject: "u1" };
const other: Principal = { tenantId: "t1", subject: "u2" };
const catalog: IntegrationCatalogEntry[] = [
  { id: "gmail", name: "Gmail" },
  { id: "slack", name: "Slack" },
];

let suffix = 0;
function uniqueDataDir(): string {
  suffix += 1;
  return `memory://connections-store-test-${Date.now()}-${suffix}`;
}

let handle: VendoDb;
let store: ReturnType<typeof createDrizzleConnectionsStore>;

beforeAll(async () => {
  handle = await createVendoDatabase({ pglite: { dataDir: uniqueDataDir() } });
  await migrateVendoDatabase(handle);
});

beforeEach(async () => {
  await handle.db.execute(sql`truncate table vendo.connections`);
  store = createDrizzleConnectionsStore(handle, scope, catalog);
});

describe("DrizzleConnectionsStore", () => {
  it("list() reflects catalog entries with connected: false by default", async () => {
    const list = await store.list();
    expect(list).toEqual([
      { id: "gmail", name: "Gmail", connected: false },
      { id: "slack", name: "Slack", connected: false },
    ]);
  });

  it("connect()/disconnect() only accept catalog ids and are Principal-scoped", async () => {
    await store.connect("gmail");
    await store.connect("not-in-catalog");
    expect(await store.connectedToolkits()).toEqual(["gmail"]);

    const otherStore = createDrizzleConnectionsStore(handle, other, catalog);
    expect(await otherStore.connectedToolkits()).toEqual([]);

    await store.disconnect("gmail");
    expect(await store.connectedToolkits()).toEqual([]);
  });

  it("survives a store rebuild against the same handle (durability)", async () => {
    await store.connect("slack");
    const rebuilt = createDrizzleConnectionsStore(handle, scope, catalog);
    expect(await rebuilt.connectedToolkits()).toEqual(["slack"]);
  });

  it("setConnectedAccount then findByConnectedAccount roundtrips the toolkit + principal", async () => {
    await store.setConnectedAccount("gmail", "acct-123");
    const found = await store.findByConnectedAccount("acct-123");
    expect(found).toEqual({ toolkit: "gmail", principal: { tenantId: "t1", subject: "u1" } });
    expect(await store.connectedToolkits()).toEqual(["gmail"]);
  });

  it("findByConnectedAccount on an unknown account resolves undefined", async () => {
    expect(await store.findByConnectedAccount("nope")).toBeUndefined();
  });

  it("disconnect revokes webhook routing — findByConnectedAccount no longer resolves the mapping (review blocker)", async () => {
    await store.setConnectedAccount("gmail", "acct-123");
    await expect(store.findByConnectedAccount("acct-123")).resolves.toEqual({
      toolkit: "gmail",
      principal: scope,
    });

    await store.disconnect("gmail");

    await expect(store.findByConnectedAccount("acct-123")).resolves.toBeUndefined();
  });
});
