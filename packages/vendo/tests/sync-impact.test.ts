import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type PermissionGrant,
  type Principal,
} from "../src/core/index.js";
import { appStore, createStore, createStoreOps, grantStore, type VendoStore } from "../src/store/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { computeImpact } from "../src/sync-impact.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_sync_impact" };

/** An app on the store. A document no longer names tools ahead of time — a
 *  screen's own `app.tsx` names host tools in its `useQuery` calls, and nothing
 *  reads those yet — so the report's `apps` bucket stays empty. */
function plainApp(id: string, name: string): AppDocument {
  return {
    format: VENDO_APP_FORMAT,
    id,
    name,
    ui: "tree",
    components: { Widgets: "export default function Widgets(){ return null; }" },
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
  it("maps tools to automations and active grants, and leaves the apps bucket empty", async () => {
    const store = await setup();
    const apps = appStore(store);
    const grants = grantStore(store);

    await apps.put(principal, plainApp("app_widgets", "Widget viewer"));
    await apps.put(principal, plainApp("app_unrelated", "Invoice viewer"));
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
        apps: [],
        automations: [{ id: "atm_refresh", title: "1h" }],
        grants: 1,
      },
      { tool: "host_absent", apps: [], automations: [], grants: 0 },
    ]);
  });
});
