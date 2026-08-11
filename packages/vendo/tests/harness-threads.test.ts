/**
 * D4/D6 — the thread lifecycle, on the door that serves the turns.
 *
 * Two halves, both over the REAL composition and the REAL store: the wire's
 * list/get/delete routes read the harness door, and they must answer exactly
 * what the door's own handle answers; and the per-thread searched-in loadout —
 * which rides the thread's harness-state slot since the de-brain refactor —
 * is still released, whether the thread is deleted by hand or swept with its
 * session. A reused id must never inherit a dead thread's tools.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, RunContext, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedModel, textTurn, toolCallTurn, type ScriptedModel } from "../src/agent-doubles.test-util.js";
import { createVendo, type CreateVendoConfig, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_threads_door" };
const ctx = (): RunContext => ({ principal, venue: "chat", presence: "present", sessionId: "s_threads" });

const tool = (name: string): ToolDescriptor => ({
  name,
  title: name,
  description: `the ${name} probe tool`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
});

const hostTools = (): ToolRegistry => ({
  async descriptors() {
    return [tool("probe_alpha"), tool("probe_beta")];
  },
  async execute() {
    return { status: "ok", output: {} };
  },
});

interface Composed {
  vendo: Vendo;
  store: VendoStore;
  model: ScriptedModel;
  chat: (text: string, threadId?: string, headers?: Record<string, string>) => Promise<Response>;
}

/**
 * The DEFAULT `vendo()` on a scripted model: composition hands it the
 * `loadout` as its tool-search strategy, so what the model may PICK each step
 * (`toolNamesPerCall`) is the real loadout under test — exactly one tool
 * starts active, and `probe_beta` is reachable only through `find_tools`.
 */
async function compose(turns: Parameters<typeof scriptedModel>[0]): Promise<Composed> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-threads-door-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  await store.ensureSchema();
  const model = scriptedModel(turns);
  const vendo = createVendo({
    models: { default: model as unknown as LanguageModel },
    principal: async () => principal,
    store,
    loadout: ["probe_alpha"],
  } as CreateVendoConfig);
  vendo.actions.add(hostTools());
  const chat = async (text: string, threadId?: string, headers: Record<string, string> = {}) => {
    const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        ...(threadId === undefined ? {} : { threadId }),
        message: { id: `m_${globalThis.crypto.randomUUID()}`, role: "user", parts: [{ type: "text", text }] },
      }),
    }));
    await response.text();
    return response;
  };
  return { vendo, store, model, chat };
}

describe("D4 — list/get/delete come off the harness door, unchanged", () => {
  it("answers the same over the wire and off the door's own handle", async () => {
    const { vendo, chat } = await compose([textTurn("hello there")]);
    const turn = await chat("hello", "thr_parity_door");
    expect(turn.status).toBe(200);

    // The wire route (which reads `deps.harness.threads`) and the door's own
    // handle agree — the survivors moved, the answers did not.
    const listed = await (await vendo.handler(new Request("https://host.test/api/vendo/threads"))).json();
    expect(listed).toEqual(await vendo.harness.threads.list(ctx()));
    expect((listed as Array<{ id: string }>).map((entry) => entry.id)).toEqual(["thr_parity_door"]);

    const fetched = await (await vendo.handler(
      new Request("https://host.test/api/vendo/threads/thr_parity_door"),
    )).json();
    expect(fetched).toEqual(await vendo.harness.threads.get("thr_parity_door", ctx()));

    const deleted = await vendo.handler(new Request("https://host.test/api/vendo/threads/thr_parity_door", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    }));
    expect(deleted.status).toBe(200);
    // Gone for both readers: one row, one repository.
    expect(await vendo.harness.threads.get("thr_parity_door", ctx())).toBeNull();
    expect(await vendo.harness.threads.list(ctx())).toEqual([]);
  });
});

describe("the searched-in loadout is released with the thread", () => {
  it("survives the next turn, and is gone after the thread is deleted", async () => {
    const { vendo, model, chat } = await compose([
      // Turn 1: search the beta probe in.
      toolCallTurn("find_tools", { query: "beta probe" }),
      textTurn("found it"),
      // Turn 2: no search — the state slot is the only way it can be offered.
      textTurn("still here"),
      // Turn 3, after the delete, same id: a fresh thread.
      textTurn("clean slate"),
    ]);
    const threadId = "thr_loadout";

    await chat("discover the beta tool", threadId);
    // The loadout really gated step one; the search made the tool choosable.
    expect(model.toolNamesPerCall[0]).toContain("probe_alpha");
    expect(model.toolNamesPerCall[0]).not.toContain("probe_beta");
    expect(model.toolNamesPerCall[1]).toContain("probe_beta");

    // The searched-in tool stays offered on the NEXT turn (the harness-state
    // slot) — this is the state `delete` has to reclaim.
    await chat("still there?", threadId);
    expect(model.toolNamesPerCall[2]).toContain("probe_beta");

    const deleted = await vendo.handler(new Request(`https://host.test/api/vendo/threads/${threadId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    }));
    expect(deleted.status).toBe(200);

    // Same id, fresh thread: it must NOT inherit the deleted thread's tools.
    await chat("clean slate?", threadId);
    expect(model.toolNamesPerCall[3]).toContain("probe_alpha");
    expect(model.toolNamesPerCall[3]).not.toContain("probe_beta");
  });

  it("is released by evictSubject too (D6), along with the subject's thread rows", async () => {
    const { vendo, store, model, chat } = await compose([
      toolCallTurn("find_tools", { query: "beta probe" }),
      textTurn("found it"),
      textTurn("clean slate"),
    ]);
    const threadId = "thr_evicted";

    await chat("discover the beta tool", threadId);
    expect(model.toolNamesPerCall[1]).toContain("probe_beta");

    const rows = async (): Promise<number> => {
      const raw = store.raw() as { query<T>(text: string): Promise<{ rows: T[] }> };
      const result = await raw.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM vendo_threads");
      return Number(result.rows[0]?.count);
    };
    expect(await rows()).toBe(1);

    // What the session sweep calls for every subject it reclaims.
    await vendo.harness.evictSubject(principal.subject);
    expect(await rows()).toBe(0);

    // Same id, fresh thread: none of the evicted thread's searched-in tools.
    await chat("clean slate?", threadId);
    expect(model.toolNamesPerCall.at(-1)).toContain("probe_alpha");
    expect(model.toolNamesPerCall.at(-1)).not.toContain("probe_beta");
  });
});
