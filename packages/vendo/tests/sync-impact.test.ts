import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TRIGGER_ID,
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  type AppDocument,
  type PermissionGrant,
  type Principal,
} from "@vendoai/core";
import { appStore, createStore, grantStore, type VendoStore } from "@vendoai/store";
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

function automation(id: string, name: string, tool: string): AppDocument {
  return {
    format: VENDO_APP_FORMAT,
    id,
    name,
    triggers: [{
      id: DEFAULT_TRIGGER_ID,
      on: { kind: "schedule", every: "1h" },
      run: { kind: "steps", steps: [{ id: "load", tool }] },
    }],
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
    await apps.put(principal, automation("app_widget_refresh", "Widget refresh", "host_get_widgets"));
    await apps.put(principal, plainApp("app_unrelated", "Invoice viewer", "host_get_invoices"));
    await grants.create(principal, grant("grt_active"));
    await grants.create(principal, grant("grt_revoked", { revokedAt: "2026-07-14T12:30:00.000Z" }));
    await grants.create(principal, grant("grt_expired", { expiresAt: "2020-01-01T00:00:00.000Z" }));

    await expect(computeImpact(store, ["host_get_widgets", "host_absent"])).resolves.toEqual([
      {
        tool: "host_get_widgets",
        apps: [{ id: "app_widgets", title: "Widget viewer" }],
        automations: [{ id: "app_widget_refresh", title: "Widget refresh" }],
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

    await expect(computeImpact(store, ["host_get_orders"])).resolves.toEqual([
      {
        tool: "host_get_orders",
        apps: [{ id: "app_island", title: "Island dashboard" }],
        automations: [],
        grants: 0,
      },
    ]);
  });

  it("counts a pre-list automation, whose document still carries the single `trigger`", async () => {
    const store = await setup();
    // Raw SQL on purpose: the record door normalizes a document on the way IN, so
    // going through it would prove nothing about the rows sitting in a deployment
    // today. This is the pre-list shape byte for byte.
    const raw = store.raw() as { query(q: string, p?: unknown[]): Promise<unknown> };
    const now = new Date().toISOString();
    await raw.query(
      `INSERT INTO vendo_apps (id, subject, enabled, doc, created_at, updated_at)
       VALUES ($1, $2, true, $3::jsonb, $4, $4)`,
      ["app_legacy_refresh", principal.subject, JSON.stringify({
        format: VENDO_APP_FORMAT,
        id: "app_legacy_refresh",
        name: "Legacy refresh",
        trigger: {
          on: { kind: "schedule", every: "1h" },
          run: { kind: "steps", steps: [{ id: "load", tool: "host_get_widgets" }] },
        },
      }), now],
    );

    // `sync` tells a person what their change will hit. Reading `doc.triggers`
    // off an unnormalized row reports "0 automations affected" for a deployment
    // whose automations all predate the trigger list — the most dangerous
    // possible answer, since it reads as "nothing to worry about".
    await expect(computeImpact(store, ["host_get_widgets"])).resolves.toEqual([
      {
        tool: "host_get_widgets",
        apps: [],
        automations: [{ id: "app_legacy_refresh", title: "Legacy refresh" }],
        grants: 0,
      },
    ]);
  });
});
