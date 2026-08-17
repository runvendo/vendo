/**
 * S4 — THE FORMING TREE ON THE WIRE, AND THE FIGURES THAT MUST NOT RIDE IT.
 *
 * The seam, with nothing stubbed on either side: a real screen goes in through
 * the real write door (`apps.authoredScreen`) onto a real store, the row is
 * marked mid-build exactly the way a build marks it (`AppDocument.building`, the
 * timestamp the shipped `buildInFlight` reads), and it comes back out through
 * the real wire route the embed actually polls. The tree in the answer is
 * painted from the stored screen by the shipped open path — not assembled here.
 *
 * What must hold is BOTH halves:
 * - the answer carries the app's geometry, so the embed has assembly to paint;
 * - it carries no figure at all. A build's draft is precisely the version whose
 *   numbers the repair round changes (`build-terminal-mount.e2e.test.ts`), so
 *   the one thing a half-built app may never show is a number.
 *
 * The second read is the control that keeps the first honest: clear `building`
 * and the SAME app, through the SAME route, pays out the figure. Without it a
 * screen that painted nothing at all would pass the strip assertions silently.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
const DOLLARS = "1337.42";

const hostTools: ToolDefinition[] = [
  {
    name: "host_balance",
    title: "Balance",
    description: "The account balance, in cents.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
    execute: async () => ({ data: { cents: CENTS } }) as unknown as Json,
  },
];

const SCREEN = `import { Stack, Stat, useQuery } from "@vendo/screen";

export default function Balance() {
  const balance = useQuery("host_balance");
  return (
    <Stack gap={12}>
      <Stat label="Balance" value={balance.data.cents / 100} format="money" />
    </Stack>
  );
}
`;

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
 *  own record surface — the same field `screenDocument` writes when a build is
 *  running and the same one `buildInFlight` reads. */
async function setBuilding(store: VendoStore, building: string | undefined): Promise<void> {
  const records = store.records("vendo_apps");
  const record = await records.get(APP_ID);
  if (record === null) throw new Error("the write door left no row to mark");
  const data = record.data as { doc: Record<string, unknown> };
  const doc = { ...data.doc };
  if (building === undefined) delete doc["building"]; else doc["building"] = building;
  await records.put({ ...record, data: { ...data, doc } });
}

describe("the build window's forming tree", () => {
  it("answers pending with the app's geometry and not one figure, and pays the figure out once the build lands", async () => {
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

    // The real write door the render seam calls when a build's save paints.
    await vendo.apps.authoredScreen({ appId: APP_ID, name: "Balance", source: SCREEN }, ctx);
    await setBuilding(store, new Date().toISOString());

    // The route the embed polls every 1.2s, verbatim.
    const open = async (): Promise<{ status: number; body: string }> => {
      const response = await vendo.handler(
        new Request(`https://host.test/api/vendo/apps/${APP_ID}/open?pending=1`),
      );
      return { status: response.status, body: await response.text() };
    };

    const midBuild = await open();
    expect(midBuild.status).toBe(200);
    const pending = JSON.parse(midBuild.body) as {
      kind: string;
      tree?: { streaming?: boolean; nodes?: Array<Record<string, unknown>> };
    };
    expect(pending.kind).toBe("pending");

    // GEOMETRY: the real screen's own nodes, so the embed paints this app
    // forming rather than a generic bar.
    const nodes = pending.tree?.nodes ?? [];
    expect(pending.tree?.streaming).toBe(true);
    // Sorted: node ORDER is the flattener's business (children first), and this
    // is an assertion about which of the screen's components survived the strip.
    expect(nodes.map((node) => node["component"]).sort()).toEqual(["Stack", "Stat"]);

    // NO FIGURES, by construction: a node carries an id, a component name and
    // its children, and there is nowhere else for a value to hide.
    expect(nodes.flatMap((node) => Object.keys(node))).toEqual(
      expect.arrayContaining(["id", "component"]),
    );
    expect(nodes.some((node) => "props" in node)).toBe(false);
    for (const key of ["data", "interactive", "components", "componentTools"]) {
      expect(pending.tree).not.toHaveProperty(key);
    }
    // The whole-body check, which no future field can slip past.
    expect(midBuild.body).not.toContain(String(CENTS));
    expect(midBuild.body).not.toContain(DOLLARS);

    // THE CONTROL. Same app, same route: once the build is no longer in flight
    // the figure is exactly what it serves — so the assertions above are the
    // strip working, never an app that painted nothing.
    await setBuilding(store, undefined);
    const landed = await open();
    expect(landed.status).toBe(200);
    expect(JSON.parse(landed.body)).toMatchObject({ kind: "tree" });
    expect(landed.body).toContain(DOLLARS);
  });
});
