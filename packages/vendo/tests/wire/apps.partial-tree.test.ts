/**
 * S4 — THE FORMING TREE ON THE WIRE: THE SHAPE, THE FIGURES, AND THE COST.
 *
 * The seam, with nothing stubbed on either side: a real document goes in through
 * a real write door (`apps.importApp`) onto a real store, the row is marked
 * mid-build exactly the way a build marks it (`AppDocument.building`, the
 * timestamp the shipped `buildInFlight` reads), and it comes back out through the
 * real wire route the embed actually polls, as real JSON.
 *
 * Three things must hold, and each has a control that would catch its opposite:
 *
 * 1. GEOMETRY rides — the app's own nodes, so the embed paints THIS app forming.
 * 2. NO FIGURE rides. The stored tree's authored label and its resolved balance
 *    are both absent from the body; once the build lands, the same route over the
 *    same row pays the balance out. A build's draft is precisely the version whose
 *    numbers its repair round changes, so this is the whole law.
 * 3. NO QUERY RUNS. The answer is READ off the row, never rendered for. This one
 *    is a regression guard with teeth: the first cut of this feature served the
 *    app and threw the result away, which ran the app, its query fan-out and a
 *    guard decision on every 1.2s poll — ~250 times per viewer per build, against
 *    the host's own backend, as the user. `executions` counts host-tool calls, so
 *    a return to that shape costs this assertion.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  type AppDocument,
  type AppId,
  type Json,
  type Principal,
  type RunContext,
  type ToolDefinition,
} from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_partial_tree" };
const ctx: RunContext = {
  principal,
  venue: "app",
  presence: "present",
  sessionId: "ses_partial_tree",
};

const APP_ID = "app_partial_tree" as AppId;

/** Deliberately unmistakable: no app id, timestamp or format tag can contain
 *  these digits, so finding them in the body means the FIGURE leaked. */
const CENTS = 133_742;
/** An authored prop that is not a number and still must not ride — props are
 *  dropped whole, so this is what proves the strip took the container. */
const LABEL = "Balance to date";

/** Every host-tool execution this deployment performs. A pending poll must add
 *  none: its answer is a row read. */
const executions: string[] = [];

const hostTools: ToolDefinition[] = [
  {
    name: "host_balance",
    title: "Balance",
    description: "The account balance, in cents.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
    execute: async () => {
      executions.push("host_balance");
      return ({ cents: CENTS }) as unknown as Json;
    },
  },
];

/** A v2 tree app mid-build: real geometry, an authored label, and a binding that
 *  only becomes a number once the query behind it runs. */
const document: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: APP_ID,
  name: "Balance",
  ui: "tree",
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["s1"] },
      { id: "s1", component: "Stat", props: { label: LABEL, value: { $path: "/balance/cents" } } },
    ],
    queries: [{ name: "balance", tool: "host_balance" }],
  },
};

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-partial-tree-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** Stamp (or clear) the in-flight marker on the stored row, through the store's
 *  own record surface — the same field `screenDocument` writes while a build is
 *  running and the same one `buildInFlight` reads. */
async function setBuilding(store: VendoStore, appId: string, building: string | undefined): Promise<void> {
  const records = store.records("vendo_apps");
  const record = await records.get(appId);
  if (record === null) throw new Error("the write door left no row to mark");
  const data = record.data as { doc: Record<string, unknown> };
  const doc = { ...data.doc };
  if (building === undefined) delete doc["building"]; else doc["building"] = building;
  await records.put({ ...record, data: { ...data, doc } });
}

describe("the build window's forming tree", () => {
  it("answers pending with the app's geometry, no figure and no query, then pays the figure out once the build lands", async () => {
    const store = await tempStore();
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store,
      tools: hostTools,
    });
    cleanups.push(async () => { await vendo.store.close(); });
    // The runtime doors are reached directly below, so the schema latch the
    // handler would have tripped on its first touch is opened by hand.
    await store.ensureSchema();

    // Import mints the row's own id, so everything below follows the document
    // the store actually holds.
    const appId = (await vendo.apps.importApp(document, ctx)).id;
    await setBuilding(store, appId, new Date().toISOString());

    // The route the embed polls every 1.2s, verbatim.
    const open = async (): Promise<{ status: number; body: string }> => {
      const response = await vendo.handler(
        new Request(`https://host.test/api/vendo/apps/${appId}/open?pending=1`),
      );
      return { status: response.status, body: await response.text() };
    };

    executions.length = 0;
    const midBuild = await open();
    expect(midBuild.status).toBe(200);
    const pending = JSON.parse(midBuild.body) as {
      kind: string;
      tree?: { streaming?: boolean; nodes?: Array<Record<string, unknown>> };
    };
    expect(pending.kind).toBe("pending");

    // 1. GEOMETRY: this app's own nodes and nesting.
    const nodes = pending.tree?.nodes ?? [];
    expect(pending.tree?.streaming).toBe(true);
    expect(nodes.map((node) => node["component"])).toEqual(["Stack", "Stat"]);
    expect(nodes.find((node) => node["id"] === "root")?.["children"]).toEqual(["s1"]);

    // 2. NO FIGURE, and no container one could hide in.
    expect(nodes.some((node) => "props" in node)).toBe(false);
    for (const key of ["data", "interactive", "components", "componentTools", "queries"]) {
      expect(pending.tree).not.toHaveProperty(key);
    }
    // The whole-body checks, which no future field can slip past.
    expect(midBuild.body).not.toContain(String(CENTS));
    expect(midBuild.body).not.toContain(LABEL);

    // 3. NO QUERY RAN. The pending answer cost a row read.
    expect(executions).toEqual([]);

    // THE CONTROL. Same app, same route: once the build is no longer in flight the
    // query runs and the figure is exactly what it serves — so every assertion
    // above is the strip working, never an app with nothing to show.
    await setBuilding(store, appId, undefined);
    const landed = await open();
    expect(landed.status).toBe(200);
    expect(JSON.parse(landed.body)).toMatchObject({ kind: "tree" });
    expect(landed.body).toContain(String(CENTS));
    expect(landed.body).toContain(LABEL);
    expect(executions).toEqual(["host_balance"]);
  });
});
