/**
 * D4/D6 — the thread lifecycle, on the door that serves the turns.
 *
 * Two halves, both over the REAL composition and the REAL store: the wire's
 * list/get/delete routes now read the harness door, and they must answer exactly
 * what the agent door answered (the survivors move, nothing a client can see
 * changes); and the per-thread tool loadout — the thing that made `delete` more
 * than a store write — is still released, whether the thread is deleted by hand
 * or swept with its session.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, RunContext, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { defineHarness, FIND_TOOLS_TOOL_NAME } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type CreateVendoConfig, type Vendo } from "./server.js";

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

/**
 * A harness driven by the user's words: it records the tool names it was offered
 * this turn, and on "discover" it searches one in through the SHIPPED rail — so
 * the loadout under test is the real one, not a stand-in.
 */
function probeHarness(seen: string[][]) {
  return defineHarness({
    name: "loadout-probe",
    async *run(turn) {
      const asked = turn.messages.at(-1)?.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("") ?? "";
      if (asked.includes("discover")) {
        await turn.tools.call(FIND_TOOLS_TOOL_NAME, { query: "beta probe" });
      }
      seen.push((await turn.tools.list()).map((entry) => entry.name));
      yield { type: "text", delta: "ok" };
    },
  });
}

const model = {
  specificationVersion: "v2",
  provider: "vendo-threads-door",
  modelId: "vendo-threads-door-v1",
  supportedUrls: {},
  async doStream() {
    return { stream: new ReadableStream({ start: (controller) => controller.close() }) };
  },
} as unknown as LanguageModel;

interface Composed {
  vendo: Vendo;
  store: VendoStore;
  seen: string[][];
  chat: (text: string, threadId?: string, headers?: Record<string, string>) => Promise<Response>;
}

async function compose(overrides: Partial<CreateVendoConfig> = {}): Promise<Composed> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-threads-door-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  await store.ensureSchema();
  const seen: string[][] = [];
  const vendo = createVendo({
    model,
    principal: async () => principal,
    store,
    // Exactly one tool starts active; the other is reachable only through
    // `find_tools`, which is what makes the loadout observable at all.
    loadout: ["probe_alpha"],
    harness: probeHarness(seen) as never,
    ...overrides,
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
  return { vendo, store, seen, chat };
}

describe("D4 — list/get/delete come off the harness door, unchanged", () => {
  it("answers the same over the wire and off the door's own handle", async () => {
    const { vendo, chat } = await compose();
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
    const { vendo, seen, chat } = await compose();
    const threadId = "thr_loadout";

    await chat("discover the beta tool", threadId);
    expect(seen[0]).toContain("probe_beta");

    // The searched-in tool stays callable for the rest of the conversation —
    // this is the state `delete` has to reclaim.
    await chat("still there?", threadId);
    expect(seen[1]).toContain("probe_beta");

    const deleted = await vendo.handler(new Request(`https://host.test/api/vendo/threads/${threadId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    }));
    expect(deleted.status).toBe(200);

    // Same id, fresh thread: it must NOT inherit the deleted thread's tools.
    await chat("clean slate?", threadId);
    expect(seen[2]).toContain("probe_alpha");
    expect(seen[2]).not.toContain("probe_beta");
  });

  it("is released by evictSubject too (D6), along with the subject's thread rows", async () => {
    const { vendo, store, seen, chat } = await compose();
    const threadId = "thr_evicted";

    await chat("discover the beta tool", threadId);
    expect(seen[0]).toContain("probe_beta");

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
    expect(seen.at(-1)).toContain("probe_alpha");
    expect(seen.at(-1)).not.toContain("probe_beta");
  });
});
