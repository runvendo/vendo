/**
 * The seam between the shipped client and the shipped door.
 *
 * `@vendoai/ui`'s `createVendoClient` is one half of a contract whose other half
 * is this package's wire route table. A ui test cannot reach the door — ui is
 * layered to `@vendoai/core` alone — so ui proved its half against a fixture
 * wire that lives in ui too: the producer and the consumer each holding their own
 * copy of the route table, unable to disagree. `test/client.test.ts` asserted
 * `(method, path, body)` triples against that fixture's own request log, which
 * says what the client SENT and nothing about whether anything serves it.
 *
 * Here nothing is stubbed on either side. Every call is the real client method;
 * every answer is the real `vendo.handler` over a real PGlite store, a real
 * agent and a real apps runtime. `fetch` is the only double, and it is a wire,
 * not a fake: it hands the client's own Request to the door and returns the
 * door's own Response.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { createVendoClient, type VendoClient } from "@vendoai/ui";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "./server.js";

const BASE = "https://maple.test/api/vendo";
/** The door reads identity off this header, and the CLIENT is the only thing
 *  that can put it there — so every route below is also proof that the client
 *  carried its configured headers on that request. */
const USER_HEADER = "x-seam-user";
const ADA: Principal = { kind: "user", subject: "user_ada" };

/** The door's answer for a path no route matches (server.ts). A client route
 *  that lands here is a client and a door that disagree — the one failure the
 *  fixture wire could never produce, because it was written from the client. */
const UNROUTED = "unknown Vendo route";

const SPENDING = `<App name="Spending">
  <Stack>
    <Text text="This month" />
  </Stack>
</App>`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

type Chunk = Record<string, unknown>;

const saveApp = (content: string): Chunk[] => [
  { type: "tool-call", toolCallId: "c1", toolName: "save_app", input: JSON.stringify({ content }) },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
];

const speak = (text: string): Chunk[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
];

/** A deterministic LanguageModelV2 double — the same shape
 *  `placements-seam.e2e.test.ts` uses. The model is the third party here, not
 *  the counterparty: the seam under test is client ↔ door. */
function scriptedModel(turns: Chunk[][]): LanguageModel {
  const answer = (): Chunk[] => turns.shift() ?? speak("nothing more to do");
  return {
    specificationVersion: "v2" as const,
    provider: "vendo-client-door-seam",
    modelId: "vendo-client-door-seam-v1",
    supportedUrls: {},
    async doGenerate() {
      const chunks = answer();
      const toolCall = chunks.find(chunk => chunk["type"] === "tool-call");
      if (toolCall !== undefined) {
        return {
          content: [{
            type: "tool-call" as const,
            toolCallId: toolCall["toolCallId"] as string,
            toolName: toolCall["toolName"] as string,
            input: toolCall["input"] as string,
          }],
          finishReason: "tool-calls" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: chunks.filter(chunk => chunk["type"] === "text-delta").map(chunk => chunk["delta"] as string).join(""),
        }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream() {
      const chunks = answer();
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
}

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-client-door-seam-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

interface Seam {
  client: VendoClient;
  /** Whether the door saw the client's header on EVERY request it answered. */
  identifiedEvery: () => boolean;
}

async function seam(turns: Chunk[][] = []): Promise<Seam> {
  const store = await tempStore();
  await store.ensureSchema();
  const identified: boolean[] = [];
  const vendo = createVendo({
    model: scriptedModel(turns),
    principal: async request => {
      const subject = request.headers.get(USER_HEADER);
      identified.push(subject !== null);
      return subject === null ? null : { kind: "user", subject };
    },
    store,
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : (input as { url: string }).url;
    return vendo.handler(new Request(url, init));
  }) as typeof fetch;
  cleanups.push(() => { globalThis.fetch = realFetch; });

  return {
    client: createVendoClient({ baseUrl: BASE, headers: { [USER_HEADER]: ADA.subject } }),
    identifiedEvery: () => identified.length > 0 && identified.every(Boolean),
  };
}

describe("the shipped client against the shipped door", () => {
  it("a turn written through the client is read back through the client", async () => {
    const { client, identifiedEvery } = await seam([speak("Here is your spending.")]);

    // WRITE: the client's own POST /threads, streamed by the real agent.
    const stream = await client.threads.stream({
      threadId: "thr_seam",
      message: { id: "msg_user", role: "user", parts: [{ type: "text", text: "show me my spending" }] },
    });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(await stream.text()).toContain("Here is your spending.");

    // READ: the same thread, back through the client's own list and get.
    const listed = await client.threads.list();
    expect(listed.map(thread => thread.id)).toContain("thr_seam");
    const thread = await client.threads.get("thr_seam");
    expect(thread.messages.some(message => JSON.stringify(message).includes("show me my spending"))).toBe(true);
    expect(thread.messages.some(message => JSON.stringify(message).includes("Here is your spending."))).toBe(true);

    // The turn's audit rows are the client's activity feed, `limit` and all.
    expect((await client.activity.list({ limit: 100 })).length).toBeGreaterThan(0);
    expect((await client.activity.list({ limit: 1 })).length).toBeLessThanOrEqual(1);

    // DELETE, and the read path agrees it is gone.
    await client.threads.delete("thr_seam");
    expect((await client.threads.list()).map(thread => thread.id)).not.toContain("thr_seam");

    // Every one of those requests carried the header the client was built with.
    expect(identifiedEvery()).toBe(true);
  });

  it("an app built through the client survives an export/import round trip and a placement", async () => {
    const { client } = await seam([saveApp(SPENDING), speak("done")]);

    // WRITE: a real build, through the client's POST /apps.
    const built = await client.apps.create({ prompt: "Spending" });
    expect((await client.apps.get(built.id)).name).toBe("Spending");
    expect((await client.apps.open(built.id)).kind).toBe("tree");
    expect((await client.apps.list()).map(app => app.id)).toContain(built.id);
    // The real contract, which the fixture wire canned as two rows: the first
    // save IS the create, so there is no earlier state to keep yet.
    expect(await client.apps.history(built.id)).toEqual([]);

    // The bytes are the DOOR's, decoded by the client, handed back to the door
    // as octet-stream — no fixture byte array can agree with itself here.
    const bytes = await client.apps.exportApp(built.id);
    expect(bytes.byteLength).toBeGreaterThan(0);
    const copy = await client.apps.importApp(bytes);
    expect(copy.id).not.toBe(built.id);
    expect((await client.apps.get(copy.id)).name).toBe("Spending");

    // Placement, the same chain ui asserted against its fixture: place → read
    // back → evict → unplace → gone. Every hop is the real route now.
    expect(await client.apps.place(built.id, "home-hero")).toEqual({});
    expect(await client.apps.placements(["home-hero"])).toEqual([
      { slot: "home-hero", app: built.id, title: "Spending", status: "ready" },
    ]);
    // A slot the page did not mount is never answered.
    expect(await client.apps.placements(["sidebar"])).toEqual([]);
    // One app per slot: the second place displaces the first and says which.
    expect(await client.apps.place(copy.id, "home-hero")).toEqual({ evicted: built.id });
    await client.apps.unplace(copy.id, "home-hero");
    expect(await client.apps.placements()).toEqual([]);

    await client.apps.delete(copy.id);
    expect((await client.apps.list()).map(app => app.id)).not.toContain(copy.id);
  });

  /** The assertion `test/client.test.ts` could not make: not "the client sent
   *  this path" but "the door serves the path the client sends". A domain refusal
   *  (not-found, validation, cloud-required) still proves the route resolved —
   *  only the door's own no-route answer fails here. */
  it("every route the client can call is a route the door recognizes", async () => {
    const { client } = await seam([speak("ok")]);
    const app = "app_absent";
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["threads.list", () => client.threads.list()],
      ["threads.get", () => client.threads.get("thr_absent")],
      ["threads.delete", () => client.threads.delete("thr_absent")],
      ["approvals.pending", () => client.approvals.pending()],
      ["approvals.get", () => client.approvals.get("apr_absent")],
      ["approvals.decide", () => client.approvals.decide("apr_absent", { approve: true })],
      ["grants.list", () => client.grants.list()],
      ["grants.revoke", () => client.grants.revoke("grt_absent")],
      ["connections.list", () => client.connections.list()],
      ["connections.catalog", () => client.connections.catalog()],
      ["connections.initiate", () => client.connections.initiate({ toolkit: "gmail" })],
      ["connections.status", () => client.connections.status("ca_absent", "composio")],
      ["connections.disconnect", () => client.connections.disconnect("ca_absent", "composio")],
      ["apps.list", () => client.apps.list()],
      ["apps.get", () => client.apps.get(app)],
      ["apps.delete", () => client.apps.delete(app)],
      ["apps.open", () => client.apps.open(app)],
      ["apps.open?pending", () => client.apps.open(app, { pending: true })],
      ["apps.call", () => client.apps.call(app, "fn:refresh", { month: "July" })],
      ["apps.edit", () => client.apps.edit(app, "add totals")],
      ["apps.history", () => client.apps.history(app)],
      ["apps.undo", () => client.apps.undo(app)],
      ["apps.exportApp", () => client.apps.exportApp(app)],
      ["apps.fork", () => client.apps.fork(app)],
      ["apps.forkPin", () => client.apps.forkPin({ appId: app, slot: "hero", instruction: "make it blue" })],
      ["apps.forkPin(slot only)", () => client.apps.forkPin({ slot: "hero" })],
      ["apps.grants", () => client.apps.grants(app)],
      ["apps.share", () => client.apps.share(app, "user_bo", "viewer")],
      ["apps.unshare", () => client.apps.unshare(app, "user_bo")],
      ["apps.promote", () => client.apps.promote(app, "org_1")],
      ["apps.resolvePerson", () => client.apps.resolvePerson(app, "bo")],
      ["apps.shipDiff", () => client.apps.shipDiff(app)],
      ["apps.pinDrift", () => client.apps.pinDrift(app)],
      ["apps.rebasePin", () => client.apps.rebasePin(app, "hero")],
      ["apps.pingMachine", () => client.apps.pingMachine(app)],
      ["apps.place", () => client.apps.place(app, "hero")],
      ["apps.unplace", () => client.apps.unplace(app, "hero")],
      ["apps.placements", () => client.apps.placements(["hero", "sales,eu"])],
      ["automations.list", () => client.automations.list()],
      ["automations.enable", () => client.automations.enable(app, "main")],
      ["automations.disable", () => client.automations.disable(app, "main")],
      ["automations.dryRun", () => client.automations.dryRun(app, "main")],
      ["runs.list", () => client.runs.list({ appId: app, status: "running", cursor: "cursor_1" })],
      ["runs.get", () => client.runs.get("run_absent")],
      ["runs.stop", () => client.runs.stop("run_absent")],
      ["runs.rerun", () => client.runs.rerun("run_absent")],
      ["activity.list", () => client.activity.list({ cursor: "aud_2", limit: 10 })],
      ["status", () => client.status()],
    ];

    // Concurrently: each call is an independent lookup of an absent id, and
    // 48 serial round trips through a real embedded Postgres is wall time this
    // assertion does not need.
    const unrouted = (await Promise.all(calls.map(async ([name, call]) => {
      try {
        await call();
        return null;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        return message.includes(UNROUTED) || message.includes("wire mount mismatch") ? name : null;
      }
    }))).filter((name): name is string => name !== null);
    expect(unrouted).toEqual([]);
  });
});
