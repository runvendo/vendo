import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT_V2,
  type AppDocument,
  type PermissionGrant,
  type Principal,
} from "@vendoai/core";
import { appStore, createStore, grantStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { computeImpact } from "./sync-impact.js";

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
      formatVersion: VENDO_TREE_FORMAT_V2,
      root: "root",
      nodes: [{ id: "root", component: "Text", props: { text: name } }],
      queries: [{ path: "/widgets", tool }],
    },
  };
}

function automation(id: string, name: string, tool: string): AppDocument {
  return {
    format: VENDO_APP_FORMAT,
    id,
    name,
    trigger: {
      on: { kind: "schedule", every: "1h" },
      run: { kind: "steps", steps: [{ id: "load", tool }] },
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
});
