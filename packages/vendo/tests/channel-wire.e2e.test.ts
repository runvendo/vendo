import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Principal } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelInboundSecret } from "../src/channels.js";
import { createVendo, type Vendo } from "../src/server.js";

/**
 * The whole text channel through the REAL composed wire: `createVendo` over a
 * real PGlite store, the real route table, the real link repository, the real
 * cloudTextChannel client — and a real HTTP console standing in for Vendo
 * Cloud, which is the only half this repo does not own.
 *
 * Nothing between the routes and the store is doubled: the link the desktop
 * page shows is the link the inbound door claims, and the reply the console
 * receives is the one a real harness turn produced.
 */

const API_KEY = "vk_live_channel_e2e";
const principal: Principal = { kind: "user", subject: "user_channel" };
const PHONE = "+15551230123";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

/** What the console received, in order. */
interface FakeConsole {
  baseUrl: string;
  sent: Array<{ conversationId: string; text: string }>;
  registered: Array<{ url: string; secret: string }>;
}

async function fakeConsole(): Promise<FakeConsole> {
  const sent: FakeConsole["sent"] = [];
  const registered: FakeConsole["registered"] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      const payload = body === "" ? {} : JSON.parse(body) as Record<string, string>;
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/channels/text/register") {
        registered.push(payload as unknown as { url: string; secret: string });
        res.end(JSON.stringify({
          identityId: "tid_e2e",
          handle: "maple",
          number: "+15550000000",
          connectCommand: "connect @maple",
        }));
        return;
      }
      if (req.url === "/api/v1/channels/text/send") {
        sent.push(payload as unknown as { conversationId: string; text: string });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: "not-found", message: req.url } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, sent, registered };
}

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-channel-wire-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** A harness that answers in one line, so the reply the console receives is a
 *  fact about the turn rather than about a model. */
const replying = defineHarness({
  name: "channel-e2e-probe",
  // eslint-disable-next-line require-yield
  async *run() {
    yield { type: "text", delta: "Two invoices are due." };
  },
});

async function compose(console_: FakeConsole): Promise<Vendo> {
  vi.stubEnv("VENDO_API_KEY", API_KEY);
  vi.stubEnv("VENDO_CLOUD_URL", console_.baseUrl);
  vi.stubEnv("VENDO_BASE_URL", "https://maple.test");
  return createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store: await tempStore(),
    harness: replying as never,
    channels: { text: true },
  } as Parameters<typeof createVendo>[0]);
}

const get = (vendo: Vendo, path: string, userAgent?: string): Promise<Response> =>
  vendo.handler(new Request(`https://maple.test/api/vendo${path}`, {
    ...(userAgent === undefined ? {} : { headers: { "user-agent": userAgent } }),
  }));

const inbound = async (vendo: Vendo, event: {
  eventId: string;
  from?: string;
  text: string;
  conversationId?: string;
  bearer?: string;
}): Promise<Response> => {
  const secret = await channelInboundSecret(API_KEY);
  return vendo.handler(new Request("https://maple.test/api/vendo/channels/text/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: event.bearer ?? `Bearer ${secret}`,
    },
    body: JSON.stringify({
      eventId: event.eventId,
      channel: "text",
      from: event.from ?? PHONE,
      text: event.text,
      conversationId: event.conversationId ?? "conv_e2e",
      receivedAt: new Date().toISOString(),
    }),
  }));
};

/** The inbound door ACKs and runs the turn detached, so every assertion about
 *  what the console received is a poll. No inner deadline: the test's own
 *  timeout is the hang detector. */
async function waitFor(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 25));
}

let cloud: FakeConsole;
let vendo: Vendo;
beforeEach(async () => {
  cloud = await fakeConsole();
  vendo = await compose(cloud);
});

describe("GET /channels/text/link — the two-text invitation", () => {
  it("sends a phone straight into the prefilled first message", async () => {
    const response = await get(vendo, "/channels/text/link", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)");

    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("sms:+15550000000")).toBe(true);
    // The router eats this message, so the command has to be complete in it.
    expect(decodeURIComponent(location)).toMatch(/body=connect @maple [23456789A-Z]{6}/);
    // Registration published THIS deployment's door, with the derived secret.
    expect(cloud.registered).toEqual([
      { url: "https://maple.test", secret: await channelInboundSecret(API_KEY) },
    ]);
  });

  it("shows a desktop the number, the code, a QR, and the second-text expectation", async () => {
    const response = await get(vendo, "/channels/text/link", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const page = await response.text();
    const code = /connect @maple ([23456789A-Z]{6})/.exec(page)?.[1];
    expect(code, "the page names the command to send").toBeDefined();
    expect(page).toContain("+15550000000");
    // The code appears a SECOND time, on its own: that second send is the one
    // that actually links, and a page that omits it links nobody.
    expect(page.split(code!).length - 1).toBeGreaterThanOrEqual(2);
    expect(page).toContain("contact card");
    expect(page).toContain("<svg");
  });
});

describe("the inbound door", () => {
  it("refuses a delivery that does not carry the derived bearer", async () => {
    const response = await inbound(vendo, { eventId: "evt_bad", text: "hello", bearer: "Bearer nope" });
    expect(response.status).toBe(401);
    expect(cloud.sent).toEqual([]);
  });

  it("claims the link on the second text, then serves every text after it as that user", async () => {
    // 1. The user asks for a code from inside the product.
    const page = await (await get(vendo, "/channels/text/link", "Macintosh")).text();
    const code = /connect @maple ([23456789A-Z]{6})/.exec(page)![1]!;
    expect(await (await get(vendo, "/channels/text")).json()).toEqual({ linked: false });

    // 2. The second text — the one the router did not eat — arrives here.
    expect((await inbound(vendo, { eventId: "evt_claim", text: code })).status).toBe(202);
    await waitFor(() => cloud.sent.length === 1);
    expect(cloud.sent[0]?.text).toContain("linked");

    // The binding is visible on the API surface, masked.
    expect(await (await get(vendo, "/channels/text")).json())
      .toEqual({ linked: true, phone: "+1 ••• ••• 0123" });

    // 3. A text from that phone runs a REAL turn and answers on the same
    //    conversation.
    expect((await inbound(vendo, { eventId: "evt_turn", text: "what do I owe?" })).status).toBe(202);
    await waitFor(() => cloud.sent.length === 2);
    expect(cloud.sent[1]).toEqual({ conversationId: "conv_e2e", text: "Two invoices are due." });

    // The turn landed in the SAME thread lifecycle the web chat reads.
    const threads = await vendo.harness.threads.list({
      principal,
      venue: "chat",
      presence: "present",
      sessionId: "s",
    });
    expect(threads).toHaveLength(1);
    expect(threads[0]?.title).toBe("what do I owe?");

    // A retried delivery is the same event, so it never runs twice.
    expect((await inbound(vendo, { eventId: "evt_turn", text: "what do I owe?" })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(cloud.sent).toHaveLength(2);

    // 4. Unlinking leaves the phone a stranger again.
    const deleted = await vendo.handler(new Request("https://maple.test/api/vendo/channels/text", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    }));
    expect(deleted.status).toBe(200);
    expect(await (await get(vendo, "/channels/text")).json()).toEqual({ linked: false });

    expect((await inbound(vendo, { eventId: "evt_after", text: "still there?" })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(cloud.sent, "an unlinked phone is served nothing").toHaveLength(2);
  }, 120_000);
});

describe("the channel's own thread", () => {
  it("never continues the user's web chat, and never puts the texting style in it", async () => {
    // A web turn first — the newest thread this subject owns.
    const web = await vendo.handler(new Request("https://maple.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thr_web_chat",
        message: { id: "w1", role: "user", parts: [{ type: "text", text: "show my balance" }] },
      }),
    }));
    await web.text();

    const page = await (await get(vendo, "/channels/text/link", "Macintosh")).text();
    await inbound(vendo, { eventId: "evt_thread_claim", text: /connect @maple ([23456789A-Z]{6})/.exec(page)![1]! });
    await waitFor(() => cloud.sent.length === 1);
    await inbound(vendo, { eventId: "evt_thread_turn", text: "and my last payment?" });
    await waitFor(() => cloud.sent.length === 2);

    const ctx = { principal, venue: "chat" as const, presence: "present" as const, sessionId: "s" };
    const threads = await vendo.harness.threads.list(ctx);
    expect(threads.map((thread) => thread.id)).toContain("thr_web_chat");
    // The text got its OWN thread: the web chat is untouched, and the hidden
    // channel-style part never landed in it — a persisted style block would
    // have every later WEB turn answering like an SMS.
    expect(threads).toHaveLength(2);
    const webThread = await vendo.harness.threads.get("thr_web_chat", ctx);
    expect(JSON.stringify(webThread?.messages)).not.toContain("over text message");
  }, 120_000);

  it("lets an already-linked phone move to another account with a fresh code", async () => {
    const first = await (await get(vendo, "/channels/text/link", "Macintosh")).text();
    await inbound(vendo, { eventId: "evt_move_1", text: /connect @maple ([23456789A-Z]{6})/.exec(first)![1]! });
    await waitFor(() => cloud.sent.length === 1);

    // The wire path, not the repository: a second code from the SAME phone.
    const second = await (await get(vendo, "/channels/text/link", "Macintosh")).text();
    const code = /connect @maple ([23456789A-Z]{6})/.exec(second)![1]!;
    await inbound(vendo, { eventId: "evt_move_2", text: code });
    await waitFor(() => cloud.sent.length === 2);
    expect(cloud.sent[1]?.text).toContain("linked");
    expect(await (await get(vendo, "/channels/text")).json())
      .toEqual({ linked: true, phone: "+1 ••• ••• 0123" });
  }, 120_000);
});

describe("vendo.channels — the named surface", () => {
  it("mints the same invitation the anchor does", async () => {
    const { url } = await vendo.channels.text.link(principal);
    expect(url.startsWith("sms:+15550000000")).toBe(true);
    expect(await vendo.channels.text.status(principal)).toEqual({ linked: false });
  });
});
