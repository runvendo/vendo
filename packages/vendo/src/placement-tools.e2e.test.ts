/**
 * PLACEMENT, through the doors a real caller actually uses.
 *
 * Every assertion here crosses a seam that a stub could hide:
 *  - the WRITE goes in over the real MCP door (register → authorize → token →
 *    JSON-RPC), through the real guard-bound registry and the real apps
 *    contribution;
 *  - the READ comes back out of the real store's `vendo_placements` rows.
 *    Nothing in this file knows how a placement is stored, and nothing in the
 *    apps runtime knows this file exists.
 *  - the PROJECTION is measured on real turns — one attended, one unattended —
 *    because the composed surface is declared STATICALLY
 *    (`toolsFromRegistry(appsAgentTools, agentToolDescriptors)` in server.ts),
 *    so the guard's projection is the only thing between an automation and a
 *    tool.
 *
 * This host has no sandbox, so `vendo_make` here is always served by the
 * ASSEMBLY engine. The escalated-builder half of `slot` is proved one layer
 * down, in `packages/apps/src/agent-tools.test.ts`, where a fake box makes that
 * route reachable.
 */
import {
  VENDO_APPS_PIN_TOOL,
  VENDO_APPS_UNPIN_TOOL,
  VENDO_MAKE_TOOL,
  makeReceiptSchema,
  type ToolListing,
} from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import type { VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  SUBJECT,
  bearer,
  openDoor,
  principal,
  runCleanups,
  runHarnessTurn,
  runUnattendedTurn,
  screenModel,
  tempStore,
} from "./mcp-door.test-util.js";
import { createVendo, type Vendo } from "./server.js";

afterEach(runCleanups);

/** A1 — placements are rows in the GENERIC records collection, keyed by refs. */
const PLACEMENTS = "vendo_placements";

interface PlacementRow {
  slot: string;
  appId: string;
  placedBy: string;
  placedAt: string;
}

const placementRows = async (store: VendoStore): Promise<PlacementRow[]> => {
  const { records } = await store.records(PLACEMENTS).list({ refs: { subject: SUBJECT } });
  return records.map((record) => record.data as unknown as PlacementRow);
};

interface Host {
  vendo: Vendo;
  store: VendoStore;
  /** One entry per turn, in order: what `turn.tools.list()` offered it. */
  listings: ToolListing[][];
}

/**
 * The composed host. No `policy`, deliberately: the guard's default runs a
 * write, so these tests measure PLACEMENT rather than the approval queue (the
 * cautious preset's parking of writes is already proven in the door parity
 * gate). `screenModel()` is what makes a `vendo_make` reach a real receipt
 * instead of the no-screen failure path.
 */
async function host(): Promise<Host> {
  const store = await tempStore();
  const listings: ToolListing[][] = [];
  const harness = defineHarness({
    name: "placement-probe",
    async *run(turn) {
      listings.push(await turn.tools.list());
      yield { type: "text", delta: "done" };
    },
  });
  const vendo = createVendo({
    model: screenModel(),
    principal: async () => principal,
    store,
    harness: harness as never,
    mcp: true,
    oauth: {
      async authorize() {
        return { subject: SUBJECT };
      },
      async principal(subject) {
        return { kind: "user", subject };
      },
    },
  } as Parameters<typeof createVendo>[0]);
  await store.ensureSchema();
  return { vendo, store, listings };
}

describe("a slot-targeted make, over the MCP door", () => {
  it("lands the app in the slot the caller aimed at, and the app it named is ready", async () => {
    const { vendo, store } = await host();
    const door = await openDoor(vendo, await bearer(vendo));

    const answered = await door.callTool(VENDO_MAKE_TOOL, {
      request: "my spending this month",
      slot: "dashboard.hero",
    });

    expect(answered.isError).toBeFalsy();
    const receipt = makeReceiptSchema.parse(JSON.parse(answered.text));
    expect(receipt.status).toBe("ready");
    const rows = await placementRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slot: "dashboard.hero", appId: receipt.id });
    // The row is written by the runtime as part of the make, so it carries its
    // own provenance rather than being reconstructed by a reader.
    expect(typeof rows[0]!.placedBy).toBe("string");
    expect(Number.isFinite(Date.parse(rows[0]!.placedAt))).toBe(true);
  });

  it("leaves no placement when no slot was named", async () => {
    const { vendo, store } = await host();
    const door = await openDoor(vendo, await bearer(vendo));

    const answered = await door.callTool(VENDO_MAKE_TOOL, { request: "my spending this month" });

    expect(answered.isError).toBeFalsy();
    expect(await placementRows(store)).toEqual([]);
  });
});

describe("pin and unpin, over the MCP door", () => {
  it("writes the row on pin and removes it on unpin", async () => {
    const { vendo, store } = await host();
    const door = await openDoor(vendo, await bearer(vendo));
    const made = await door.callTool(VENDO_MAKE_TOOL, { request: "my spending this month" });
    const { id } = makeReceiptSchema.parse(JSON.parse(made.text));

    const pinned = await door.callTool(VENDO_APPS_PIN_TOOL, { app: id, slot: "sidebar.one" });
    expect(pinned.isError).toBeFalsy();
    expect(JSON.parse(pinned.text)).toEqual({ app: id, slot: "sidebar.one" });
    expect(await placementRows(store)).toEqual([
      expect.objectContaining({ slot: "sidebar.one", appId: id }),
    ]);

    const unpinned = await door.callTool(VENDO_APPS_UNPIN_TOOL, { app: id, slot: "sidebar.one" });
    expect(unpinned.isError).toBeFalsy();
    expect(await placementRows(store)).toEqual([]);
  });
});

describe("THE LAW, for a tool whose whole effect is on a person's screen", () => {
  it("offers the placement pair to a present person and withholds it from an unattended run", async () => {
    const { vendo, listings } = await host();

    await runHarnessTurn(vendo, "thr_present", "what can you do");
    await runUnattendedTurn(vendo, "thr_away", "run the nightly job");

    const [present, away] = listings.map((listed) => listed.map((tool) => tool.name));
    expect(present).toContain(VENDO_APPS_PIN_TOOL);
    expect(present).toContain(VENDO_APPS_UNPIN_TOOL);
    expect(away).not.toContain(VENDO_APPS_PIN_TOOL);
    expect(away).not.toContain(VENDO_APPS_UNPIN_TOOL);
    // And the front door is untouched: an automation may still MAKE something.
    expect(away).toContain(VENDO_MAKE_TOOL);
  });
});
