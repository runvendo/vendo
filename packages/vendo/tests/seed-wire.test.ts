// The wire leg of the ✦ gesture: POST /apps/seed { component, slot?, instruction? }
// mints an ordinary app whose seeded seat holds the captured baseline, records
// the optional `slot` as a PLACEMENT row (the seed on the document is
// provenance, never location), and validates the body shape loudly.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedComponentName, type AppDocument, type Principal } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

const principal: Principal = { kind: "user", subject: "user_seed_wire" };

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  process.chdir(originalCwd);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("POST /apps/seed — the ✦ gesture over the wire", () => {
  it("seeds the captured component into a new app, places it, and rejects a malformed body", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-seed-wire-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const component = "TopMerchants";
    const source = "export default function TopMerchants() { return <p>merchants</p>; }\n";
    await mkdir(join(root, ".vendo", "remixable"), { recursive: true });
    await writeFile(join(root, ".vendo", "remixable", `${component}.json`), JSON.stringify({
      slot: component,
      source,
      hash: "sha256:seed-wire-baseline",
      exportable: false,
      capturedAt: "2026-08-02T00:00:00.000Z",
    }));
    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);

    // No model configured: the gesture is deterministic and must not need one.
    const vendo = createVendo({ principal: async () => principal, store, development: true });

    const seedResponse = await vendo.handler(request("POST", "/apps/seed", { component, slot: "dashboard" }));
    expect(seedResponse.status).toBe(200);
    const app = await seedResponse.json() as AppDocument;
    // Provenance is ONE record on the document, and it carries the slot asked for.
    expect(app.seed).toEqual({ component, baseline: "sha256:seed-wire-baseline", slot: "dashboard" });
    const componentName = seedComponentName(component);
    expect(app.components?.[componentName]).toMatchObject({ source, origin: "seeded" });
    expect(app.tree?.nodes).toContainEqual(expect.objectContaining({
      component: componentName,
      source: "generated",
    }));

    // The slot is a PLACEMENT row, readable on the slots' own route.
    const placements = await (await vendo.handler(request("GET", "/apps/placements?slots=dashboard"))).json();
    expect(placements).toContainEqual(expect.objectContaining({ slot: "dashboard", app: app.id }));

    // A non-string component is a loud validation error, not a silent drop.
    const malformed = await vendo.handler(request("POST", "/apps/seed", { component: 7 }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("validation");

    // A component the host never captured is a loud not-found.
    const uncaptured = await vendo.handler(request("POST", "/apps/seed", { component: "NeverSynced" }));
    expect(uncaptured.status).toBe(404);
  });
});
