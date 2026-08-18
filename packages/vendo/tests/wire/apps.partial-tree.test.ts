/**
 * WATCHING A CODE-FIRST APP BE BORN — the producer and the consumer, no stub
 * on either side.
 *
 * The producer is the REAL render seam: a half-written `app.tsx` lands through
 * the real workspace commit interception and the real checks floor, which is what
 * a build does on every landed commit. The consumer is the REAL wire route the
 * embed polls every 1.2s. Nothing between them is a double, so they can disagree.
 *
 * Three things must hold, and each has a control that would catch its opposite:
 *
 * 1. The shape GROWS. The first paint's geometry answers the poll, and the
 *    second paint's — one node larger — answers the next, so the embed paints
 *    this app assembling rather than a bar.
 * 2. NO FIGURE rides while it grows. The screen's authored label and the balance
 *    its query resolves are both absent from the pending body; once the build
 *    settles, the same route over the same row pays both out. A build's draft is
 *    precisely the version whose numbers its repair round changes, so this is the
 *    whole law.
 * 3. NO QUERY RUNS for a poll. The answer is READ, never rendered for. This one
 *    is a regression guard with teeth: serving the app per poll would run its
 *    query fan-out and a guard decision ~250 times per viewer per build, against
 *    the host's own backend, as the user. `executions` counts host-tool calls.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapWorkspaceForRender } from "@vendoai/apps";
import type { Json, Principal, RunContext, ToolDefinition } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { testWorkspace } from "../../src/agent-doubles.test-util.js";
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

const APP_ID = "app_partial_tree";
const APP_TSX = `/user/apps/${APP_ID}/app.tsx`;

/** Deliberately unmistakable: no app id, timestamp or format tag can contain
 *  these digits, so finding them in the body means the FIGURE leaked. */
const CENTS = 133_742;
/** An authored prop that is not a number and still must not ride — props are
 *  dropped whole, so this is what proves the strip took the container. */
const LABEL = "Balance to date";

/** Every host-tool execution this deployment performs. A pending poll must add
 *  none: its answer is a shape the build already painted. */
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

/** The build's FIRST paint: the frame, and nothing in it yet. */
const HALF = `import { Stack, Text } from "@vendo/screen";

export default function Balance() {
  return (
    <Stack gap={12}>
      <Text text="Account" variant="heading" />
    </Stack>
  );
}
`;

/** The build's SECOND paint: one node larger, and now carrying both figures. */
const FULL = `import { Stack, Text, useQuery } from "@vendo/screen";

export default function Balance() {
  const balance = useQuery("host_balance");
  return (
    <Stack gap={12}>
      <Text text="Account" variant="heading" />
      <Text key={String(balance.cents)} text={"${LABEL}: " + String(balance.cents)} />
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
 *  own record surface — the same field a build's saves write and the same one
 *  `buildInFlight` reads. */
async function setBuilding(store: VendoStore, appId: string, building: string | undefined): Promise<void> {
  const records = store.records("vendo_apps");
  const record = await records.get(appId);
  if (record === null) throw new Error("the paint left no row to mark");
  const data = record.data as { doc: Record<string, unknown> };
  const doc = { ...data.doc };
  if (building === undefined) delete doc["building"]; else doc["building"] = building;
  await records.put({ ...record, data: { ...data, doc } });
}

describe("the build window's forming tree", () => {
  it("paints the app growing, with no figure until the build lands", async () => {
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

    // THE PRODUCER, wired the way composition wires it (`harness-turn.ts`): the
    // real commit interception over the real checks floor. Every save below is a
    // build landing a commit on `app.tsx`.
    const workspace = wrapWorkspaceForRender(testWorkspace(), {
      floor: vendo.apps.floor(ctx),
      emit: () => undefined,
    });
    const save = async (content: string): Promise<void> => {
      await workspace.writeFile(APP_TSX, content);
      await workspace.commit();
    };

    // THE CONSUMER — the route the embed polls every 1.2s, verbatim.
    const open = async (): Promise<{ status: number; body: string }> => {
      const response = await vendo.handler(
        new Request(`https://host.test/api/vendo/apps/${APP_ID}/open?pending=1`),
      );
      return { status: response.status, body: await response.text() };
    };
    const shapeOf = (body: string): Array<Record<string, unknown>> => {
      const pending = JSON.parse(body) as { kind: string; tree?: { streaming?: boolean; nodes?: Array<Record<string, unknown>> } };
      expect(pending.kind).toBe("pending");
      expect(pending.tree?.streaming).toBe(true);
      return pending.tree?.nodes ?? [];
    };
    /** The flattened nodes come out in the paint's own order (children first),
     *  which is the renderer's business — what this file measures is WHICH
     *  components are there and how they nest. */
    const components = (nodes: Array<Record<string, unknown>>): string[] =>
      nodes.map((node) => node["component"] as string).sort();

    // The first painting save is what mints the row, so the build's marker goes
    // on after it — exactly the order a build writes in.
    await save(HALF);
    await setBuilding(store, APP_ID, new Date().toISOString());

    executions.length = 0;
    const first = await open();
    expect(first.status).toBe(200);
    expect(components(shapeOf(first.body))).toEqual(["Stack", "Text"]);

    // 1. IT GROWS: the next paint's geometry is what the next poll answers.
    await save(FULL);
    executions.length = 0;
    const second = await open();
    const grown = shapeOf(second.body);
    expect(components(grown)).toEqual(["Stack", "Text", "Text"]);
    expect(grown.find((node) => node["component"] === "Stack")?.["children"]).toHaveLength(2);

    // 2. NO FIGURE, and no container one could hide in.
    expect(grown.some((node) => "props" in node)).toBe(false);
    // Including the last container that is not a prop: the second `Text` is
    // keyed on the balance itself, and `flatten.ts` spells a key straight into
    // the node's id (`Text:133742`).
    expect(grown.map((node) => node["id"]).join(" ")).not.toContain(String(CENTS));
    for (const key of ["data", "interactive", "components", "componentTools", "queries"]) {
      expect(JSON.parse(second.body).tree).not.toHaveProperty(key);
    }
    // The whole-body checks, which no future field can slip past.
    expect(second.body).not.toContain(String(CENTS));
    expect(second.body).not.toContain(LABEL);

    // 3. NO QUERY RAN. The poll read a shape the build had already painted.
    expect(executions).toEqual([]);

    // THE CONTROL. Same app, same route: once the build is no longer in flight the
    // query runs and both figures are exactly what it serves — so every assertion
    // above is the strip working, never an app with nothing to show.
    await setBuilding(store, APP_ID, undefined);
    const landed = await open();
    expect(landed.status).toBe(200);
    expect(JSON.parse(landed.body)).toMatchObject({ kind: "tree" });
    expect(landed.body).toContain(String(CENTS));
    expect(landed.body).toContain(LABEL);
    expect(executions).toEqual(["host_balance"]);
  }, 120_000);
});
