/**
 * THE ARRIVAL SEAM — who is allowed to clear a person's dot.
 *
 * "Rendering marks it seen" has to mean rendering TO A PERSON, and the only way
 * to prove that is a real deployment where both callers exist:
 *
 *   person  `GET /apps/:id/open` — the route a browser's embed asks for a
 *           surface through
 *   agent   `AppsRuntime.open` — the SAME door `vendo_apps_open` hands an MCP
 *           client (compose-mcp.ts) and an automation resolves a surface with
 *
 * Real store, real route table, real apps pack, and the answer read back through
 * the real `GET /apps`. A stub on either side would let the route and the door
 * agree about a rule neither of them actually runs — which is how the mark ended
 * up on the door in the first place, where an agent inspecting a tree cleared a
 * dot for a screen its owner had never seen.
 *
 * The one that must be able to fail: move the `apps.seen` call out of the open
 * route and phase 3 goes red; put one back inside `AppsRuntime.open` and phase 2
 * goes red.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toVendoWirePart,
  VENDO_APP_FORMAT,
  vendoViewPart,
  type AppDocument,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ADA: Principal = { kind: "user", subject: "user_ada" };

const doc = (id: string, name: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
});

/** The agent's context: the venue an MCP call really arrives on. */
const agentCtx: RunContext = {
  principal: ADA,
  venue: "mcp",
  presence: "present",
  sessionId: "s_agent",
};

async function setup(): Promise<{ vendo: Vendo; store: VendoStore }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-apps-seen-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  await store.records("vendo_apps").put({
    id: "app_arrival",
    data: { subject: ADA.subject, enabled: false, doc: doc("app_arrival", "Spending") },
    refs: { subject: ADA.subject },
  });
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async (req) => (req.headers.get("x-test-user") === null
      ? null
      : { kind: "user", subject: req.headers.get("x-test-user") as string }),
    store,
  });
  return { vendo, store };
}

/** The thread the person will open, carrying the view part a turn left behind.
 *  Built with the REAL producer (`vendoViewPart` plus its wire envelope), so the
 *  part this consumer counts is the one the four emitters actually write. */
async function seedRenderedThread(store: VendoStore): Promise<void> {
  const view = vendoViewPart({
    appId: "app_arrival",
    payload: {
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [{ id: "root", component: "Stack", source: "prewired" }],
    },
  });
  if (view === undefined) throw new Error("the view part fixture does not parse");
  await store.records("vendo_threads").put({
    id: "thr_arrival",
    data: {
      subject: ADA.subject,
      messages: [{ id: "m_view", role: "assistant", parts: [toVendoWirePart(view.part, view.streamId)] }],
    },
    refs: { subject: ADA.subject },
  });
}

const request = (vendo: Vendo, path: string): Promise<Response> =>
  vendo.handler(new Request(`http://arrival.test/api/vendo${path}`, {
    headers: { "x-test-user": ADA.subject },
  }));

/** Read the arrival flag back through the route a panel really lists with. */
async function unseen(vendo: Vendo): Promise<boolean | undefined> {
  const response = await request(vendo, "/apps");
  expect(response.status).toBe(200);
  const rows = await response.json() as Array<{ id: string; unseen?: boolean }>;
  return rows.find((row) => row.id === "app_arrival")?.unseen;
}

describe("an app is seen when a PERSON renders it, not when an agent reads it", () => {
  it("stays unseen through an agent's open and clears on the person's own", async () => {
    const { vendo } = await setup();

    // 1 — nobody has looked at it yet.
    expect(await unseen(vendo)).toBe(true);

    // 2 — the agent reads the whole tree through the runtime door. This is a
    // real render for Claude and no render at all for Ada.
    const opened = await vendo.apps.open("app_arrival", agentCtx);
    expect(opened.kind).toBe("tree");
    expect(await unseen(vendo)).toBe(true);

    // 3 — Ada's browser asks for the surface.
    expect((await request(vendo, "/apps/app_arrival/open")).status).toBe(200);
    expect(await unseen(vendo)).toBeUndefined();
  });

  /**
   * The thread render. The card draws the app from the `data-vendo-view` part
   * itself and never opens anything, so the transcript read is the only server
   * event a thread render has — and an away run WRITES that part into a sponsor's
   * thread while nobody is watching, which is why the part existing cannot be the
   * mark.
   */
  it("stays unseen while the view part merely sits in the transcript, and clears when the person opens it", async () => {
    const { vendo, store } = await setup();
    expect(await unseen(vendo)).toBe(true);

    // The negative control: the part is in the thread — written exactly as an
    // away run leaves it — and nobody has read the conversation.
    await seedRenderedThread(store);
    expect(await unseen(vendo)).toBe(true);

    // The positive: Ada opens the conversation, which renders the app.
    expect((await request(vendo, "/threads/thr_arrival")).status).toBe(200);
    expect(await unseen(vendo)).toBeUndefined();
  });
});
