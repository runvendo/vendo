import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Principal, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelInboundSecret } from "../src/channels.js";
import { createVendo, guard, type Vendo } from "../src/server.js";

/**
 * Consent over text — the seam that decides whether this channel is allowed to
 * do anything that matters.
 *
 * A gated call parks exactly as it does on the web (approve-resume.e2e.test.ts
 * is the same shape one layer down); the difference is WHERE the tap comes
 * from. The card becomes an outbound text carrying the real action and its real
 * arguments, and the word "YES" arriving from the linked phone decides the SAME
 * approval record the turn is blocked on — so the effect lands, from a phone,
 * with no screen anywhere.
 *
 * Presence is what makes that possible: this ctx says a person IS here. Flip
 * `presence` to "away" in channel-turn.ts and this file goes red — the call is
 * refused before anyone can answer, and no YES can rescue it.
 */

const API_KEY = "vk_live_channel_approval";
const principal: Principal = { kind: "user", subject: "user_approval" };
const PHONE = "+15557770123";
const PAY_TOOL = "maple_bills_pay";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

/** `attempts` counts every delivery the channel TRIED, `sent` only the ones that
    landed — the two diverge while `failSends` is on, which is how a test says
    "the vendor was down exactly when the card went out". */
interface FakeConsole {
  baseUrl: string;
  sent: Array<{ conversationId: string; text: string; final?: boolean }>;
  attempts: number;
  failSends: boolean;
}

async function fakeConsole(): Promise<FakeConsole> {
  const state: FakeConsole = { baseUrl: "", sent: [], attempts: 0, failSends: false };
  const sent = state.sent;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/channels/text/register") {
        res.end(JSON.stringify({
          identityId: "tid_approval",
          handle: "maple",
          number: "+15550000000",
          connectCommand: "connect @maple",
        }));
        return;
      }
      if (req.url === "/api/v1/channels/text/send") {
        state.attempts += 1;
        if (state.failSends) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: { code: "unavailable", message: "carrier down" } }));
          return;
        }
        sent.push(JSON.parse(body) as { conversationId: string; text: string; final?: boolean });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  state.baseUrl = `http://127.0.0.1:${port}`;
  return state;
}

/** The host-side observable: what actually got paid. */
function payingHost(): { tools: ToolRegistry; paid: Array<{ billId: string; amount: number }> } {
  const paid: Array<{ billId: string; amount: number }> = [];
  const descriptor: ToolDescriptor = {
    name: PAY_TOOL,
    title: "Pay a bill",
    description: "Pay one of the customer's bills",
    inputSchema: {
      type: "object",
      properties: {
        billId: { type: "string" },
        amount: { type: "number", description: "Amount in cents (whole number), e.g. 4200 = $42.00" },
      },
      required: ["billId", "amount"],
    },
    risk: "write",
  };
  return {
    paid,
    tools: {
      async descriptors() {
        return [descriptor];
      },
      async execute(call) {
        paid.push(call.args as { billId: string; amount: number });
        return { status: "ok", output: { paid: true } };
      },
    },
  };
}

/** One gated call, then a word about how it went. */
const paying = defineHarness({
  name: "channel-approval-probe",
  async *run(turn) {
    const result = await turn.tools.call(PAY_TOOL, { billId: "bill_9", amount: 4200 });
    yield { type: "text", delta: result.status === "ok" ? "Paid the electric bill." : "I didn't pay it." };
  },
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-channel-approval-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

async function waitFor(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe.sequential("consent over text", () => {
  it("parks, asks by text, and lands the effect the moment YES arrives", async () => {
    const cloud = await fakeConsole();
    vi.stubEnv("VENDO_API_KEY", API_KEY);
    vi.stubEnv("VENDO_CLOUD_URL", cloud.baseUrl);
    vi.stubEnv("VENDO_BASE_URL", "https://maple.test");
    const host = payingHost();
    const vendo: Vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore(),
      harness: paying as never,
      // Every write-class call asks — the mutation gate this whole test is about.
      guard: guard({ policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } }),
      channels: { text: true },
    } as Parameters<typeof createVendo>[0]);
    vendo.actions.add(host.tools);

    const secret = await channelInboundSecret(API_KEY);
    const text = (eventId: string, body: string): Promise<Response> =>
      vendo.handler(new Request("https://maple.test/api/vendo/channels/text/inbound", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          eventId,
          channel: "text",
          from: PHONE,
          text: body,
          conversationId: "conv_approval",
          receivedAt: new Date().toISOString(),
        }),
      }));

    // Link the phone, the way a user does: mint a code, then send it.
    const page = await (await vendo.handler(
      new Request("https://maple.test/api/vendo/channels/text/link", { headers: { "user-agent": "Macintosh" } }),
    )).text();
    const code = /connect @maple ([23456789A-Z]{6})/.exec(page)![1]!;
    await text("evt_link", code);
    await waitFor(() => cloud.sent.length === 1);

    // The ask.
    await text("evt_pay", "pay my electric bill");
    await waitFor(() => cloud.sent.length === 2);
    const ask = cloud.sent[1]!;
    expect(ask.conversationId).toBe("conv_approval");
    // The exact action and the exact arguments — a yes given over text is
    // consent given without a screen, so the text has to carry what a card would.
    // And it reads like a text, never like machinery: one labelled line per
    // argument (label from the schema's own description when it has one), and
    // the tool identifier never reaches the person (live 2026-08-18: the ask
    // rendered as `host_transferMoney {"amount":2500…}` for a $25.00 send).
    // "approval", not "OK": the decider only matches YES/NO, so the header
    // must never advertise a reply word that would not decide it.
    expect(ask.text).toContain("Pay a bill — needs your approval:");
    expect(ask.text).not.toMatch(/\bOK\b/);
    expect(ask.text).toContain("- billId: bill_9");
    expect(ask.text).toContain("- Amount in cents: 4200");
    expect(ask.text).not.toContain(PAY_TOOL);
    expect(ask.text).not.toContain("{");
    expect(ask.text).toContain("Reply YES");
    // Nothing has happened yet: the gate is holding the write.
    expect(host.paid).toEqual([]);

    // The tap, as a text message.
    await text("evt_yes", "YES");

    // THE POINT: the effect lands, and the turn that was blocked delivers its
    // own reply on the same conversation.
    await waitFor(() => host.paid.length === 1);
    expect(host.paid).toEqual([{ billId: "bill_9", amount: 4200 }]);
    await waitFor(() => cloud.sent.length === 3);
    expect(cloud.sent[2]).toEqual({ conversationId: "conv_approval", text: "Paid the electric bill.", final: true });
  }, 120_000);

  it("never decides a card that did not go out over this channel", async () => {
    // THE FAILURE THIS PINS: "the newest pending approval for this subject" is
    // not the same thing as "the card I texted you". The same person can have
    // one open in a web tab, and a YES sent to answer the TEXT would silently
    // approve the web one — consent for a money-moving call, given on a surface
    // that never showed it.
    const cloud = await fakeConsole();
    vi.stubEnv("VENDO_API_KEY", API_KEY);
    vi.stubEnv("VENDO_CLOUD_URL", cloud.baseUrl);
    vi.stubEnv("VENDO_BASE_URL", "https://maple.test");
    const host = payingHost();
    const vendo: Vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore(),
      harness: paying as never,
      guard: guard({ policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } }),
      channels: { text: true },
    } as Parameters<typeof createVendo>[0]);
    vendo.actions.add(host.tools);

    const secret = await channelInboundSecret(API_KEY);
    const text = (eventId: string, body: string): Promise<Response> =>
      vendo.handler(new Request("https://maple.test/api/vendo/channels/text/inbound", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          eventId,
          channel: "text",
          from: PHONE,
          text: body,
          conversationId: "conv_approval",
          receivedAt: new Date().toISOString(),
        }),
      }));

    const page = await (await vendo.handler(
      new Request("https://maple.test/api/vendo/channels/text/link", { headers: { "user-agent": "Macintosh" } }),
    )).text();
    await text("evt_link_3", /connect @maple ([23456789A-Z]{6})/.exec(page)![1]!);
    await waitFor(() => cloud.sent.length === 1);

    // The channel's card goes out first...
    await text("evt_pay_3", "pay my electric bill");
    await waitFor(() => cloud.sent.length === 2);

    // ...then the SAME user parks one from the web, which is now the newest.
    const web = await vendo.guardedTools.execute(
      { id: "call_web", tool: PAY_TOOL, args: { billId: "bill_web", amount: 99_999 } },
      { principal, venue: "chat", presence: "present", sessionId: "session_web_tab" },
    );
    if (web.status !== "pending-approval") throw new Error("expected the web call to park");

    await text("evt_yes_3", "YES");

    // The channel's own call ran; the web card is untouched and still waiting.
    await waitFor(() => host.paid.length === 1);
    expect(host.paid).toEqual([{ billId: "bill_9", amount: 4200 }]);
    const stillPending = await vendo.guard.approvals.pending(principal);
    expect(stillPending.map((request) => request.id)).toContain(web.approvalId);
  }, 120_000);

  it("a NO leaves the world untouched", async () => {
    const cloud = await fakeConsole();
    vi.stubEnv("VENDO_API_KEY", API_KEY);
    vi.stubEnv("VENDO_CLOUD_URL", cloud.baseUrl);
    vi.stubEnv("VENDO_BASE_URL", "https://maple.test");
    const host = payingHost();
    const vendo: Vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore(),
      harness: paying as never,
      guard: guard({ policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } }),
      channels: { text: true },
    } as Parameters<typeof createVendo>[0]);
    vendo.actions.add(host.tools);

    const secret = await channelInboundSecret(API_KEY);
    const text = (eventId: string, body: string): Promise<Response> =>
      vendo.handler(new Request("https://maple.test/api/vendo/channels/text/inbound", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          eventId,
          channel: "text",
          from: PHONE,
          text: body,
          conversationId: "conv_approval",
          receivedAt: new Date().toISOString(),
        }),
      }));

    const page = await (await vendo.handler(
      new Request("https://maple.test/api/vendo/channels/text/link", { headers: { "user-agent": "Macintosh" } }),
    )).text();
    await text("evt_link_2", /connect @maple ([23456789A-Z]{6})/.exec(page)![1]!);
    await waitFor(() => cloud.sent.length === 1);

    await text("evt_pay_2", "pay my electric bill");
    await waitFor(() => cloud.sent.length === 2);
    await text("evt_no", "no");

    await waitFor(() => cloud.sent.length === 3);
    expect(cloud.sent[2]?.text).toBe("I didn't pay it.");
    expect(host.paid).toEqual([]);
  }, 120_000);

  it("never decides a card whose text never reached the phone", async () => {
    // THE FAILURE THIS PINS: the card is raised, but the carrier is down and the
    // text carrying its action and arguments never arrives. Recording the ask
    // before the send lands would leave that unseen card answerable, so the next
    // bare YES — sent for any reason at all — would move money the person was
    // never shown. A delivery that failed must leave nothing to answer.
    const cloud = await fakeConsole();
    vi.stubEnv("VENDO_API_KEY", API_KEY);
    vi.stubEnv("VENDO_CLOUD_URL", cloud.baseUrl);
    vi.stubEnv("VENDO_BASE_URL", "https://maple.test");
    const host = payingHost();
    const vendo: Vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore(),
      harness: paying as never,
      guard: guard({ policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } }),
      channels: { text: true },
    } as Parameters<typeof createVendo>[0]);
    vendo.actions.add(host.tools);

    const secret = await channelInboundSecret(API_KEY);
    const text = (eventId: string, body: string): Promise<Response> =>
      vendo.handler(new Request("https://maple.test/api/vendo/channels/text/inbound", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          eventId,
          channel: "text",
          from: PHONE,
          text: body,
          conversationId: "conv_approval",
          receivedAt: new Date().toISOString(),
        }),
      }));

    const page = await (await vendo.handler(
      new Request("https://maple.test/api/vendo/channels/text/link", { headers: { "user-agent": "Macintosh" } }),
    )).text();
    await text("evt_link_4", /connect @maple ([23456789A-Z]{6})/.exec(page)![1]!);
    await waitFor(() => cloud.sent.length === 1);

    // The carrier goes down, then the call parks: the ask is attempted and
    // rejected, so the phone is holding nothing.
    cloud.failSends = true;
    await text("evt_pay_4", "pay my electric bill");
    await waitFor(() => cloud.attempts >= 2);
    expect(cloud.sent).toHaveLength(1);

    await text("evt_yes_4", "YES");

    // The YES found no answerable card, so it ran as an ordinary turn — which
    // parks a card of its own and attempts its own (still failing) delivery.
    // That further attempt is the proof the YES was treated as a new ask and
    // not as consent for the card nobody ever saw.
    await waitFor(() => cloud.attempts >= 3);

    // THE POINT: the money never moved. Record the ask before the send lands
    // and this is a paid bill the person was never shown.
    expect(host.paid).toEqual([]);

    // Release both parked turns so their ten-minute waiters do not outlive the
    // test — nothing here is asserting on the denial.
    for (const request of await vendo.guard.approvals.pending(principal)) {
      await vendo.guard.approvals.decide(request.id, { approve: false }, principal);
    }
  }, 120_000);
});
