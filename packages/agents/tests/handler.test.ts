/**
 * The one mount, over the REAL composed agent — real embedded store, real
 * guard, real runtime; only the thinker is scripted (CLAUDE.md: test the SEAM).
 *
 * What matters here is that ONE catch-all really does serve three planes: the
 * engine's door answers without ever meeting `resolveUser`, the approvals wire
 * answers on its own mount, and this table serves the conversation — with the
 * thread that came out of a turn readable back through the routes a browser
 * reloads against.
 */
import type { RunContext } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore } from "@vendoai/store";
import { describe, expect, it } from "vitest";
import { agent } from "../src/agent.js";
import { DOOR_PATH } from "../src/door.js";
import { agentHandler, type HandlerOptions } from "../src/handler.js";
import { tool } from "../src/tools.js";
import { THREAD_ID_HEADER } from "../src/index.js";

let stores = 0;
const memoryStore = () => createStore({ dataDir: `memory://agents-handler-${stores++}` });

const BASE = "/api/agent";

const speaks = (text: string) =>
  defineHarness({
    name: "speaks",
    async *run() {
      yield { type: "text" as const, delta: text };
    },
  });

/** A `Turn` deliberately carries no RunContext (packages/core/src/harness.ts:72),
 *  so the ctx a request composed is observed where it really lands: in a tool. */
let seen: RunContext | undefined;
/** Read through a call: assigning `undefined` before each test narrows the
 *  binding, and the write happens in a callback the compiler cannot follow. */
const lastCtx = (): RunContext | undefined => seen;
const peek = tool({
  name: "host_peek",
  description: "Report who is asking",
  inputSchema: { type: "object", properties: {} },
  risk: "read",
  execute(_input, ctx) {
    seen = ctx;
    return {};
  },
});

const peeking = () =>
  defineHarness({
    name: "peeking",
    async *run(turn) {
      await turn.tools.call("host_peek", {});
      yield { type: "text" as const, delta: "ok" };
    },
  });

const boxy = () =>
  defineHarness({
    name: "boxy",
    requires: { toolDoor: true },
    async *run() {},
  });

const dana = async (): Promise<{ subject: string }> => ({ subject: "user_dana" });

function mount(
  options: Partial<HandlerOptions> & { harness?: ReturnType<typeof speaks> } = {},
): (request: Request) => Promise<Response> {
  const { harness, ...handlerOptions } = options;
  const support = agent({
    name: "support",
    harness: harness ?? speaks("hello"),
    store: memoryStore(),
    tools: [peek],
    door: { baseUrl: "https://app.example.com" },
  });
  return agentHandler(support, { basePath: BASE, resolveUser: dana, ...handlerOptions });
}

const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`https://app.example.com${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });

const say = (text: string, threadId?: string): Request =>
  request("POST", `${BASE}/threads`, {
    ...(threadId === undefined ? {} : { threadId }),
    message: { id: `msg_${text}`, role: "user", parts: [{ type: "text", text }] },
  });

/** One turn, DRAINED — the stream's finish is what persists the transcript. */
async function turn(handle: (request: Request) => Promise<Response>, text: string, threadId?: string) {
  const response = await handle(say(text, threadId));
  await response.text();
  return response;
}

describe("identity", () => {
  it("401s when the host's session says nobody is asking", async () => {
    const handle = mount({ resolveUser: async () => null });

    expect((await handle(say("hi"))).status).toBe(401);
  });

  it("carries the resolved user's profile and context onto the turn", async () => {
    seen = undefined;
    const handle = mount({
      harness: peeking(),
      resolveUser: async () => ({ subject: "user_dana", profile: { plan: "pro" }, context: { tenantId: "t_1" } }),
    });

    await turn(handle, "hello");

    expect(lastCtx()?.principal.subject).toBe("user_dana");
    expect(lastCtx()?.user).toEqual({ plan: "pro" });
    expect(lastCtx()?.context).toEqual({ tenantId: "t_1" });
  });

  it("forwards the request's own headers by default, and none with headers: false", async () => {
    const authorized = (): Request =>
      new Request(`https://app.example.com${BASE}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer host-session" },
        body: JSON.stringify({ message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] } }),
      });

    seen = undefined;
    await (await mount({ harness: peeking() })(authorized())).text();
    const forwarded = lastCtx();

    seen = undefined;
    await (await mount({ harness: peeking(), headers: false })(authorized())).text();

    expect(forwarded?.requestHeaders?.["authorization"]).toBe("Bearer host-session");
    expect(lastCtx()?.requestHeaders).toBeUndefined();
  });
});

describe("the conversation", () => {
  it("answers a turn with the thread id, and reads that thread back", async () => {
    const handle = mount();

    const response = await turn(handle, "hello");
    const threadId = response.headers.get(THREAD_ID_HEADER);

    expect(threadId).toMatch(/^thr_/);
    const listed = await (await handle(request("GET", `${BASE}/threads`))).json() as Array<{ id: string }>;
    expect(listed.map((thread) => thread.id)).toEqual([threadId]);

    const thread = await (await handle(request("GET", `${BASE}/threads/${threadId}`)))
      .json() as { id: string; messages: Array<{ role: string }> };
    expect(thread.id).toBe(threadId);
    expect(thread.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("continues the thread it is handed", async () => {
    const handle = mount();
    const first = await turn(handle, "hello");
    const threadId = first.headers.get(THREAD_ID_HEADER)!;

    const second = await turn(handle, "again", threadId);

    expect(second.headers.get(THREAD_ID_HEADER)).toBe(threadId);
    const thread = await (await handle(request("GET", `${BASE}/threads/${threadId}`)))
      .json() as { messages: unknown[] };
    expect(thread.messages).toHaveLength(4);
  });

  it("deletes a thread, and answers not-found for one this subject does not own", async () => {
    const handle = mount();
    const threadId = (await turn(handle, "hello")).headers.get(THREAD_ID_HEADER)!;

    expect((await handle(request("DELETE", `${BASE}/threads/${threadId}`))).status).toBe(200);
    expect((await handle(request("GET", `${BASE}/threads/${threadId}`))).status).toBe(404);
    expect((await handle(request("GET", `${BASE}/threads/thr_someone_else`))).status).toBe(404);
  });

  it("answers not-found outside its own mount", async () => {
    const handle = mount();

    const response = await handle(request("GET", "/api/other/threads"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not-found", message: "unknown route" } });
  });

  it("names the slice that owns durable resume rather than inventing its rules", async () => {
    const handle = mount();

    const response = await handle(request("POST", `${BASE}/turns/trn_1/resume`, { decisions: {} }));

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: { code: "not-implemented" } });
  });
});

describe("the other two planes", () => {
  it("serves the permission wire on its OWN mount, scoped to the resolved user", async () => {
    const handle = mount();

    const response = await handle(request("GET", `${BASE}/approvals`));

    // Under this basePath and behind this mount's `resolveUser` — no second
    // identity to configure, and reachable by a client that only knows `api`.
    // Deciding an approval is what unblocks a parked turn, so a client that
    // cannot reach this wire has a park it can never answer.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("hands the door its own path without ever asking who is calling", async () => {
    let asked = 0;
    const handle = mount({
      harness: boxy(),
      resolveUser: async () => {
        asked += 1;
        return { subject: "user_dana" };
      },
    });

    const response = await handle(request("POST", DOOR_PATH, {}));

    expect(response.status).not.toBe(404);
    expect(asked).toBe(0);
  });
});
