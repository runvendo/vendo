// The wire leg of the ✦ gesture: POST /apps/seed { component, instruction, slot? }
// mints an ordinary app carrying the remix's provenance and runs the
// instruction through the ordinary edit door, records the optional `slot` as a
// PLACEMENT row (the seed on the document is provenance, never location), and
// validates the body shape loudly.
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
      // The splitter's half. This component binds nothing and renders one
      // display tag, so its port is the component itself — and without a port
      // there is no ✦ at all, which is a different route's answer.
      ported: { source, tools: [], holes: [] },
    }));
    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);

    // No model configured: the mint still lands, and the edit it rides on fails
    // without stranding the caller with an error over an app that exists.
    const vendo = createVendo({ principal: async () => principal, store, development: true });

    const seedResponse = await vendo.handler(request("POST", "/apps/seed", {
      component,
      instruction: "rank them by amount",
      slot: "dashboard",
    }));
    expect(seedResponse.status).toBe(200);
    const app = await seedResponse.json() as AppDocument;
    // Provenance is ONE record on the document: where it came from, what was
    // asked for, and the slot the gesture came from.
    expect(app.seed).toEqual({
      component,
      baseline: "sha256:seed-wire-baseline",
      wishes: ["rank them by amount"],
      slot: "dashboard",
    });
    // The PORT is the app's own source — that is the fork now: the model edits
    // the component's ported code, and for a component this trivial the port IS
    // the captured source, byte for byte. What "no captured source" still
    // guarantees is the bundle: no captured component node lands on the remix.
    expect(app.components?.[seedComponentName(component)]).toBeUndefined();
    expect(app.source?.["app.tsx"]?.text).toBe(source);

    // The screen is what the first edit generates, tens of seconds after the
    // row lands — here never, because there is no model. A build that cannot
    // happen is TERMINAL, not pending: the flagged open answers with the
    // reason, so the ✦ surface says "didn't load" instead of polling forever.
    const notReady = await vendo.handler(request("GET", `/apps/${app.id}/open?pending=1`));
    expect(notReady.status).toBe(200);
    expect(await notReady.json()).toMatchObject({ kind: "failed", retryable: true });

    // The slot is a PLACEMENT row, readable on the slots' own route.
    const placements = await (await vendo.handler(request("GET", "/apps/placements?slots=dashboard"))).json();
    expect(placements).toContainEqual(expect.objectContaining({ slot: "dashboard", app: app.id }));

    // A non-string component is a loud validation error, not a silent drop —
    // and so is a gesture with no instruction, because there are no bare forks.
    for (const body of [{ component: 7, instruction: "x" }, { component }]) {
      const malformed = await vendo.handler(request("POST", "/apps/seed", body));
      expect(malformed.status).toBe(400);
      expect((await malformed.json()).error.code).toBe("validation");
    }

    // A component the host never captured is a loud not-found.
    const uncaptured = await vendo.handler(request("POST", "/apps/seed", {
      component: "NeverSynced",
      instruction: "rank them by amount",
    }));
    expect(uncaptured.status).toBe(404);
  });
});
