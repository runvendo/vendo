/**
 * PLACEMENT, through the doors a real caller actually uses.
 *
 * Every assertion here crosses a seam that a stub could hide:
 *  - the WRITE goes in over the real MCP door (register → authorize → token →
 *    JSON-RPC), through the real guard-bound registry and the real apps
 *    contribution;
 *  - the READ comes back out of the real store's `vendo_placements` rows, and
 *    what the slot SHOWS out of the real `GET /apps/placements` route a browser
 *    polls — the status is derived server-side, so a build that lands (or that
 *    never does) is measured where the person would see it. Nothing in this file
 *    knows how a placement is stored, and nothing in the apps runtime knows this
 *    file exists.
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
  VENDO_SLOTS_LIST_TOOL,
  type ToolListing,
  type ToolResult,
} from "@vendoai/core";
import {
  makeReceiptSchema,
} from "@vendoai/apps/contract";
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
  tapWhenItAppears,
  tempStore,
} from "../src/mcp-door.test-util.js";
import { createVendo, type Vendo } from "../src/server.js";

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

/** What a slot on the page actually SHOWS, over the same route a browser polls
 *  — the real read path, with the build status derived server-side. */
interface PlacementEntry { slot: string; app: string; title: string; status: string }

const placementEntries = async (vendo: Vendo): Promise<PlacementEntry[]> => {
  const response = await vendo.handler(new Request("https://host.test/api/vendo/apps/placements"));
  return await response.json() as PlacementEntry[];
};

interface Host {
  vendo: Vendo;
  store: VendoStore;
  /** One entry per turn, in order: what `turn.tools.list()` offered it. */
  listings: ToolListing[][];
}

/** What a turn does after it has listed, so a test can drive a real CALL
 *  through the same guard-bound registry the listing came from. */
type OnTurn = (tools: { call(name: string, args: unknown): Promise<ToolResult> }) => Promise<void>;

/** One firing of a scheduled automation. `runUnattendedTurn` carries no app,
 *  and 05 §6 binds an away run's captured authority to the app it runs for, so
 *  a firing that means to spend a grant has to name one. */
const fireAutomation = async (vendo: Vendo, threadId: string): Promise<void> => {
  const response = await vendo.harness.stream({
    threadId,
    message: { id: `m_${threadId}`, role: "user", parts: [{ type: "text", text: "run the nightly job" }] },
    ctx: {
      principal,
      venue: "automation",
      presence: "away",
      sessionId: `session_${threadId}`,
      appId: "app_nightly",
      trigger: { runId: `run_${threadId}`, kind: "schedule" },
    },
  } as never);
  await response.text();
};

/**
 * The composed host. No `policy`, deliberately: the guard's default runs a
 * write, so these tests measure PLACEMENT rather than the approval queue (the
 * cautious preset's parking of writes is already proven in the door parity
 * gate). `screenModel()` is what makes a `vendo_make` reach a real receipt
 * instead of the no-screen failure path.
 */
async function host(onTurn?: OnTurn): Promise<Host> {
  const store = await tempStore();
  const listings: ToolListing[][] = [];
  const harness = defineHarness({
    name: "placement-probe",
    async *run(turn) {
      listings.push(await turn.tools.list());
      await onTurn?.(turn.tools);
      yield { type: "text", delta: "done" };
    },
  });
  const vendo = createVendo({
    models: { default: screenModel() },
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
    // And through the read path a slot on the page actually polls: READY, the
    // other end of the same transition the failure case below measures.
    expect(await placementEntries(vendo)).toEqual([
      { slot: "dashboard.hero", app: receipt.id, title: receipt.title, status: "ready" },
    ]);
  });

  it("holds the slot with the honest failure when assembly cannot serve the ask", async () => {
    // B1's failure half, end to end. A make that dies in assembly used to write
    // no row at all: the slot the caller aimed at showed NOTHING and the failure
    // existed only in the conversation.
    //
    // The failure is real, not injected — this host's screen agent can serve one
    // ask, so the second reaches the same door and comes back with nothing that
    // renders. Nothing is stubbed on either side: the write goes over the real
    // MCP door and the status comes back out of GET /apps/placements.
    const { vendo, store } = await host();
    const door = await openDoor(vendo, await bearer(vendo));
    await door.callTool(VENDO_MAKE_TOOL, { request: "my spending this month" });

    const answered = await door.callTool(VENDO_MAKE_TOOL, {
      request: "match my invoices to payments",
      slot: "dashboard.hero",
    });

    const receipt = makeReceiptSchema.parse(JSON.parse(answered.text));
    expect(receipt.status).toBe("failed");
    // The row exists at all — the gap this closes left none.
    expect(await placementRows(store)).toEqual([
      expect.objectContaining({ slot: "dashboard.hero", appId: receipt.id }),
    ]);
    // …and the read path calls it FAILED now, not a skeleton that only becomes a
    // failure once the build window ages out.
    expect(await placementEntries(vendo)).toEqual([
      { slot: "dashboard.hero", app: receipt.id, title: receipt.title, status: "failed" },
    ]);
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
  it("pins to a slot the list tool handed back, so the id is never invented", async () => {
    const { vendo, store } = await host();
    // The host's page reports its slot the way a browser does — the real route,
    // no fixture. Nothing else in this test tells the server the slot exists.
    await vendo.handler(new Request("https://host.test/api/vendo/slots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slots: [{
          id: "dashboard.main",
          label: "Dashboard",
          description: "main dashboard area, where users keep KPI views",
        }],
      }),
    }));

    const door = await openDoor(vendo, await bearer(vendo));
    const listed = JSON.parse((await door.callTool(VENDO_SLOTS_LIST_TOOL, {})).text) as
      { id: string; label: string; description?: string }[];
    expect(listed).toEqual([{
      id: "dashboard.main",
      label: "Dashboard",
      description: "main dashboard area, where users keep KPI views",
    }]);

    const made = await door.callTool(VENDO_MAKE_TOOL, { request: "my spending this month" });
    const { id } = makeReceiptSchema.parse(JSON.parse(made.text));
    // The id the caller pins with is the one the LIST answered with, never a
    // literal typed into this test — which is the whole point of the tool.
    const pinned = await door.callTool(VENDO_APPS_PIN_TOOL, { app: id, slot: listed[0]!.id });

    expect(pinned.isError).toBeFalsy();
    expect(await placementRows(store)).toEqual([
      expect.objectContaining({ slot: "dashboard.main", appId: id }),
    ]);
  });

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

  /**
   * Ruled 2026-08-06. A slot needs a person there; CREATING does not. Refusing
   * a slot-bearing `vendo_make` outright would silently break every automation
   * that legitimately builds a screen, so the call runs and the slot is the
   * only thing dropped.
   *
   * Nothing is stubbed on either side: the call crosses the same guard-bound
   * registry that refuses the pin tool above, on a real away run holding the
   * real captured authority such a run needs (05 §6 — parked on the first
   * firing, granted by one present tap, spent by the second). The "no
   * placement" half is read straight out of the store's rows.
   */
  it("builds a slot-bearing make on an unattended run and takes no slot", async () => {
    const outcomes: ToolResult[] = [];
    const { vendo, store } = await host(async (tools) => {
      outcomes.push(await tools.call(VENDO_MAKE_TOOL, {
        request: "my spending this month",
        slot: "dashboard.hero",
      }));
    });

    // First firing: away runs hold only captured authority, so this parks a
    // card. The person taps it once, present, and the automation fires again.
    await fireAutomation(vendo, "thr_nightly_1");
    await tapWhenItAppears(vendo, VENDO_MAKE_TOOL, true);
    await fireAutomation(vendo, "thr_nightly_2");

    // Not blocked, and not a refusal dressed as an error: the app was made.
    const outcome = outcomes.at(-1);
    expect(outcome?.status).toBe("ok");
    const receipt = makeReceiptSchema.parse((outcome as { output: unknown }).output);
    expect(receipt.status).toBe("ready");
    const listed = await vendo.handler(new Request("https://host.test/api/vendo/apps"));
    expect((await listed.json() as Array<{ id: string }>).map((app) => app.id)).toContain(receipt.id);
    // The slot, and only the slot, is what nobody was there to consent to.
    expect(await placementRows(store)).toEqual([]);
  });
});
