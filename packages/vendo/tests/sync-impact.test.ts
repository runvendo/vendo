import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  type AppDocument,
  type PermissionGrant,
  type Principal,
} from "@vendoai/core";
import { appStore, createStore, createStoreOps, grantStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { computeImpact } from "../src/sync-impact.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_sync_impact" };

function plainApp(id: string, name: string, tool: string): AppDocument {
  return {
    format: VENDO_APP_FORMAT,
    id,
    name,
    ui: "tree",
    tree: {
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [{ id: "root", component: "Text", props: { text: name } }],
      queries: [{ name: "widgets", tool }],
    },
  };
}

function grant(
  id: string,
  overrides: Partial<PermissionGrant> = {},
): PermissionGrant {
  return {
    id,
    subject: principal.subject,
    tool: "host_get_widgets",
    descriptorHash: "sha256:widgets",
    scope: { kind: "tool" },
    duration: "standing",
    source: "chat",
    grantedAt: "2026-07-14T12:00:00.000Z",
    ...overrides,
  };
}

async function setup(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-sync-impact-"));
  const store = createStore({ dataDir });
  await store.ensureSchema();
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

describe("computeImpact", () => {
  it("maps tools to enabled apps, automations, and active grants across subjects", async () => {
    const store = await setup();
    const apps = appStore(store);
    const grants = grantStore(store);

    await apps.put(principal, plainApp("app_widgets", "Widget viewer", "host_get_widgets"));
    await apps.put(principal, plainApp("app_unrelated", "Invoice viewer", "host_get_invoices"));
    // An automation is its OWN record now — the impact report reads that
    // drawer, not an app's document, so a steps task naming the tool is what
    // puts a deployment in the "this will change something running" bucket.
    await store.records("vendo_automations").put({
      id: "atm_refresh",
      data: {
        id: "atm_refresh",
        owner: principal,
        when: { kind: "schedule", every: "1h" },
        task: { kind: "steps", steps: [{ id: "load", tool: "host_get_widgets" }] },
        armed: true,
        authoredBy: "chat",
        createdAt: "2026-07-14T12:00:00.000Z",
        updatedAt: "2026-07-14T12:00:00.000Z",
      },
      refs: { subject: principal.subject },
    });
    await grants.create(principal, grant("grt_active"));
    await grants.create(principal, grant("grt_revoked", { revokedAt: "2026-07-14T12:30:00.000Z" }));
    await grants.create(principal, grant("grt_expired", { expiresAt: "2020-01-01T00:00:00.000Z" }));

    await expect(computeImpact(createStoreOps(store), ["host_get_widgets", "host_absent"])).resolves.toEqual([
      {
        tool: "host_get_widgets",
        apps: [{ id: "app_widgets", title: "Widget viewer" }],
        automations: [{ id: "atm_refresh", title: "1h" }],
        grants: 1,
      },
      { tool: "host_absent", apps: [], automations: [], grants: 0 },
    ]);
  });

  it("counts the tools an island's generated SOURCE calls, not just the tree's queries", async () => {
    const store = await setup();
    // `componentTools` is the compiler-stamped manifest of what each generated
    // island's code calls through the ambient `tools` API — calls that by
    // construction never appear in tree.queries or node props. Missing it makes
    // `vendo sync` answer "no saved references" for a tool live apps call.
    await appStore(store).put(principal, {
      format: VENDO_APP_FORMAT,
      id: "app_island",
      name: "Island dashboard",
      ui: "tree",
      tree: {
        formatVersion: VENDO_TREE_FORMAT,
        root: "root",
        nodes: [{ id: "root", component: "OrdersPanel", props: {} }],
        queries: [],
      },
      componentTools: { OrdersPanel: ["host_get_orders"] },
    });

    await expect(computeImpact(createStoreOps(store), ["host_get_orders"])).resolves.toEqual([
      {
        tool: "host_get_orders",
        apps: [{ id: "app_island", title: "Island dashboard" }],
        automations: [],
        grants: 0,
      },
    ]);
  });
});
