// @vitest-environment jsdom
/**
 * The `request_connection` seam.
 *
 * The agent DECIDES to ask (the tool, in @vendoai/agent) and the chrome RENDERS
 * the ask (the connect card, in @vendoai/ui). Those are two packages that never
 * import each other, and the only thing joining them is the shape of one
 * `connect-required` outcome as it crosses the wire. A test that hand-writes
 * that outcome on the render side proves nothing — it is the producer and the
 * consumer each holding their own copy, exactly how the host-component previews
 * shipped green and dead.
 *
 * So nothing here is stubbed on either side. A real harness turn calls the real
 * tool through the real `createVendo` composition (real store, real connector,
 * real registry, real connect port over the real connections catalog); the door
 * persists and serves the turn; the shipped `VendoThread` reads that thread back
 * over the real client and paints the real `ConnectCard`. The only double is the
 * network itself — `fetch` is routed straight into the door's handler.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connector } from "@vendoai/actions";
import { AGENT_CONTEXT_MARK, type Principal } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import { VendoProvider, createVendoClient } from "@vendoai/ui";
import { VendoThread } from "@vendoai/ui/chrome";
import type { LanguageModel } from "ai";
import { createElement, act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "./server.js";

const BASE = "https://host.test/api/vendo";
const principal: Principal = { kind: "user", subject: "user_seam" };
const REASON = "I need Gmail to draft your spending summary.";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  document.body.innerHTML = "";
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-request-connection-seam-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** A broker that can CONNECT gmail and nothing else — the connect port reads
 *  its `listConnectable`, so "which toolkits are askable" is this connector's
 *  real answer, not a constant in the test. */
function gmailBroker(): Connector {
  return {
    name: "composio",
    descriptors: async () => [],
    execute: async () => ({ status: "ok", output: {} }),
    connections: {
      list: async () => [],
      listConnectable: async () => [{ toolkit: "gmail" }],
      initiate: async () => ({ id: "conn_seam", status: "pending", redirectUrl: "https://connect.test/oauth/seam" }),
      status: async () => null,
      disconnect: async () => {},
    },
  } as unknown as Connector;
}

/** One turn: the model asks for a connection, then says so in prose. Whatever
 *  the tool answered is what the wire carries — this never writes an outcome. */
function askingHarness(toolkit: string, seen: unknown[]) {
  return defineHarness({
    name: "connect-asker",
    async *run(turn) {
      // A second turn (the decline continuation) must not ask again.
      if (seen.length > 0) {
        yield { type: "text", delta: "Understood — I'll leave Gmail out of it." };
        return;
      }
      seen.push(await turn.tools.call("request_connection", { toolkit, reason: REASON }));
      yield { type: "text", delta: "I'll need that connection first." };
    },
  });
}

function compose(toolkit: string) {
  const seen: unknown[] = [];
  const sent: Array<Record<string, unknown>> = [];
  return { seen, sent, build: async () => {
    const store = await tempStore();
    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      store,
      connectors: [gmailBroker()],
      harness: askingHarness(toolkit, seen) as never,
    } as Parameters<typeof createVendo>[0]);

    // The client's fetch IS the door. Every read the thread makes — the thread
    // itself, /connections, /connections/catalog — is answered by the real
    // composition, so nothing about the rendered card is arranged here.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // jsdom's AbortSignal is not undici's, and undici's Request rejects it
      // outright ("Expected signal to be an instance of AbortSignal") — which
      // reads in the UI as a turn that failed to stream. Nothing here needs to
      // abort, so the signal is dropped at the boundary.
      const { signal: _signal, ...rest } = init ?? {};
      const url = typeof input === "string" || input instanceof URL ? String(input) : (input as { url: string }).url;
      const request = new Request(url, rest as RequestInit);
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/threads")) {
        sent.push(await request.clone().json() as Record<string, unknown>);
      }
      return vendo.handler(request);
    }) as typeof fetch;
    cleanups.push(() => { globalThis.fetch = realFetch; });
    return vendo;
  } };
}

/** Drive the asking turn and drain its stream, so the thread is persisted. */
async function runTurn(vendo: { handler(request: Request): Promise<Response> }, threadId: string, text: string) {
  const response = await vendo.handler(new Request(`${BASE}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId, message: { id: `m_${threadId}`, role: "user", parts: [{ type: "text", text }] } }),
  }));
  const body = await response.text();
  expect(response.status).toBe(200);
  return body;
}

// --- rendering, without a component-test harness in this package -------------

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(element: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => act(() => root.unmount()));
  await act(async () => { root.render(element); });
}

const thread = (threadId: string, client: ReturnType<typeof createVendoClient>) =>
  createElement(VendoProvider, { client, children: createElement(VendoThread, { threadId }) });

/** Poll the painted DOM. The budget is the test's own — a tighter inner clock
 *  would report a product bug whenever the machine is merely busy. */
async function until<T>(what: string, probe: () => T | null | undefined | false): Promise<T> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    let found: T | null | undefined | false;
    await act(async () => {
      found = probe();
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
  }
}

const card = () => document.querySelector<HTMLElement>("[data-vendo-connect-card]");
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(candidate =>
    (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").trim() === label);

describe("request_connection: the agent asks, the chrome renders the ask", () => {
  it("a tool call becomes a real connect card, in the model's own words", async () => {
    const { seen, build } = compose("gmail");
    const vendo = await build();
    await runTurn(vendo, "thr_ask", "draft me an email summarising this week's spending");

    // The deciding side, first: the real registry answered through the real
    // connect port, which resolved gmail off the broker's own catalog.
    expect(JSON.stringify(seen[0])).toContain("connect");

    await mount(thread("thr_ask", createVendoClient({ baseUrl: BASE })));
    const painted = await until("the connect card", card);

    expect(painted.getAttribute("data-vendo-connect-card")).toBe("idle");
    // The message on the card is the sentence the MODEL wrote, carried whole.
    expect(painted.textContent).toContain(REASON);
    // Brand-forward, and plain about what connecting grants — never a scope.
    expect(painted.textContent).toContain("Connecting lets us read and send mail as you.");
    expect(painted.textContent).not.toContain("googleapis.com");
    expect(button("Connect Gmail")).toBeTruthy();
    expect(button("Not now")).toBeTruthy();
  });

  it("declining tells the agent through hidden context and leaves a re-offerable record", async () => {
    const { sent, build } = compose("gmail");
    const vendo = await build();
    await runTurn(vendo, "thr_decline", "draft me an email summarising this week's spending");

    await mount(thread("thr_decline", createVendoClient({ baseUrl: BASE })));
    await until("the connect card", card);
    await act(async () => { button("Not now")!.click(); });

    // The record, on the turn that asked: one line, and the offer survives —
    // "not now" is a moment's answer, not a standing one. (Once the agent's
    // NEXT turn lands the ask is stale, and a stale uncompleted ask leaves the
    // transcript entirely — the pre-existing live/stale rule, unchanged.)
    const collapsed = card()!;
    expect(collapsed.getAttribute("data-vendo-connect-card")).toBe("skipped");
    expect(collapsed.textContent).toContain("Skipped — Gmail isn’t connected");
    expect(button("Connect Gmail")).toBeTruthy();

    // And the agent is the one waiting on that answer, so it hears it — as
    // agent context, never as a bubble the user did not type.
    const decline = await until("the decline message", () =>
      sent.find(body => JSON.stringify(body).includes("Declined to connect Gmail.")));
    expect(JSON.stringify(decline)).toContain("[vendo:context]");
    expect(document.body.textContent).not.toContain("vendo:context");
  });

  /** uiaudit 2026-08-06 — the same hidden line, one surface later. The chrome's
   *  card answers are sent as bare marked text, and a fresh conversation's first
   *  message is sometimes exactly that; the title is minted server-side in
   *  @vendoai/agent, which knew nothing about the mark. Written through the real
   *  door and read back through the real `GET /threads` listing — the rail's own
   *  read path, no stub on either side. */
  it("a hidden context message never becomes the thread's listed title", async () => {
    const { build } = compose("gmail");
    const vendo = await build();
    await runTurn(vendo, "thr_hidden_title", `${AGENT_CONTEXT_MARK} Declined to connect Gmail.`);

    const listing = await vendo.handler(new Request(`${BASE}/threads`));
    expect(listing.status).toBe(200);
    const rows = await listing.json() as Array<{ id: string; title: string }>;
    const row = rows.find(entry => entry.id === "thr_hidden_title");
    expect(row).toBeDefined();
    expect(row!.title).not.toContain(AGENT_CONTEXT_MARK);
  });

  it("a toolkit this deployment cannot connect is refused, and paints no card", async () => {
    const { seen, build } = compose("salesforce");
    const vendo = await build();
    await runTurn(vendo, "thr_unknown", "pull my pipeline into an email");

    // Not a card with a dead button: an error the model can act on.
    expect(JSON.stringify(seen[0])).toContain("not-found");
    expect(JSON.stringify(seen[0])).toContain("list_connections");

    await mount(thread("thr_unknown", createVendoClient({ baseUrl: BASE })));
    await until("the assistant turn", () => document.body.textContent?.includes("connection first"));
    expect(card()).toBeNull();
  });
});
