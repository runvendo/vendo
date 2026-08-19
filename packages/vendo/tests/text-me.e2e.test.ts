import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { automationsInternals } from "@vendoai/automations";
import type { Principal, RunContext } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelInboundSecret } from "../src/channels.js";
import { createVendo, guard, type Vendo } from "../src/server.js";
import { VENDO_TEXT_ME_TOOL } from "../src/text-me.js";

/**
 * `vendo_text_me` end to end, over the REAL composition: real `createVendo`, real
 * guard, real automations engine, one real PGlite store, the real
 * `cloudTextChannel` client — and an HTTP console standing in for the one half
 * this repo does not own.
 *
 * WHY IT IS SHAPED THIS WAY: the thing worth proving is not that a registry
 * returns a descriptor, it is that an automation somebody armed MONTHS ago puts a
 * text on a real phone, and that the same automation without that consent puts
 * nothing anywhere. Producer (the tool) and consumer (the console's send route)
 * are on opposite sides of a wire here, with no stub between them — the send this
 * suite asserts on is a request the console actually received.
 */

const API_KEY = "vk_live_text_me";
const owner: Principal = { kind: "user", subject: "user_text_me" };
const PHONE = "+15551239999";
const CONVERSATION = "conv_text_me";

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  // The ladder reads the key itself; a developer's real key must never decide
  // what this suite observes.
  vi.stubEnv("VENDO_API_KEY", "");
  vi.stubEnv("VENDO_CLOUD_URL", "");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

/** What the console received, in order — the only witness that says a text
 *  really went out rather than that a tool said "ok". */
interface FakeConsole {
  baseUrl: string;
  sent: Array<{ conversationId: string; text: string; final?: boolean }>;
  /** On, the router has no live assignment for the conversation: a 404, exactly
   *  as a lapsed iMessage identity answers. */
  failSends: boolean;
}

async function fakeConsole(): Promise<FakeConsole> {
  const state: FakeConsole = { baseUrl: "", sent: [], failSends: false };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/channels/text/register") {
        res.end(JSON.stringify({
          identityId: "tid_text_me",
          handle: "maple",
          number: "+15550000000",
          connectCommand: "connect @maple",
        }));
        return;
      }
      if (req.url === "/api/v1/channels/text/send") {
        if (state.failSends) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: { code: "not-found", message: "no active assignment" } }));
          return;
        }
        state.sent.push(JSON.parse(body) as { conversationId: string; text: string; final?: boolean });
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

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-text-me-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const replying = defineHarness({
  name: "text-me-probe",
  // eslint-disable-next-line require-yield
  async *run() {
    yield { type: "text", delta: "Two invoices are due." };
  },
});

async function compose(cloud: FakeConsole | undefined, policy?: "ask" | "run"): Promise<Vendo> {
  if (cloud !== undefined) {
    vi.stubEnv("VENDO_API_KEY", API_KEY);
    vi.stubEnv("VENDO_CLOUD_URL", cloud.baseUrl);
  }
  vi.stubEnv("VENDO_BASE_URL", "https://maple.test");
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => owner,
    store: await tempStore(),
    harness: replying as never,
    ...(policy === undefined ? {} : { guard: guard({ policy: { rules: [{ match: { risk: "write" }, action: policy }] } }) }),
    ...(cloud === undefined ? {} : { channels: { text: true } }),
  } as Parameters<typeof createVendo>[0]);
  return vendo;
}

const inbound = async (vendo: Vendo, eventId: string, text: string): Promise<Response> =>
  vendo.handler(new Request("https://maple.test/api/vendo/channels/text/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await channelInboundSecret(API_KEY)}`,
    },
    body: JSON.stringify({
      eventId,
      channel: "text",
      from: PHONE,
      text,
      conversationId: CONVERSATION,
      receivedAt: new Date().toISOString(),
    }),
  }));

async function waitFor(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 25));
}

/** A linked, texting user: the code from the link page, then one real message —
 *  which is what teaches the link row the conversation a later text rides on. */
async function linkAndText(vendo: Vendo, cloud: FakeConsole): Promise<void> {
  const page = await (await vendo.handler(
    new Request("https://maple.test/api/vendo/channels/text/link", { headers: { "user-agent": "Macintosh" } }),
  )).text();
  await inbound(vendo, "evt_link", /connect @maple ([23456789A-Z]{6})/.exec(page)![1]!);
  await waitFor(() => cloud.sent.length === 1);
  await inbound(vendo, "evt_hello", "how much is due?");
  await waitFor(() => cloud.sent.length === 2);
}

const away: RunContext = {
  principal: owner,
  venue: "automation",
  presence: "away",
  sessionId: "sess_text_me",
};
const present: RunContext = {
  principal: owner,
  venue: "chat",
  presence: "present",
  sessionId: "sess_text_me_web",
};

describe.sequential("Text me", () => {
  it("delivers a real text from an armed automation, and nothing at all without its grant", async () => {
    const cloud = await fakeConsole();
    const vendo = await compose(cloud);
    await linkAndText(vendo, cloud);

    const record = await automationsInternals(vendo.automations).create({
      owner,
      when: { event: "rent.cleared" },
      // Step args are JSONata, so a literal message is a quoted string.
      task: { kind: "steps", steps: [{ id: "tell", tool: VENDO_TEXT_ME_TOOL, args: { text: "'Your rent cleared.'" } }] },
      authoredBy: "chat",
    }, away);

    // Armed, holding nothing: the away downgrade forces an ask and the run ends
    // LOUDLY. No new consent machinery is involved — this is the same standing
    // grant flow every other tool descriptor goes through.
    const [refusedId] = await vendo.emit("rent.cleared", {}, owner);
    expect(await vendo.automations.runs.get(refusedId!, away)).toMatchObject({
      automationId: record.id,
      status: "error",
      error: { code: "needs-permission", tool: VENDO_TEXT_ME_TOOL },
    });
    // THE POINT of the negative half: the refusal reached the wire, not just a
    // status. The console received nothing beyond the two linking texts.
    expect(cloud.sent).toHaveLength(2);

    // One tap on the real guard — exactly what an arming card sends.
    const pending = await vendo.guard.approvals.pending(owner);
    expect(pending.map((ask) => ask.ctx.trigger?.automationId)).toEqual([record.id]);
    await vendo.guard.approvals.decide([pending[0]!.id], { approve: true }, owner);
    expect(await vendo.guard.grants.list(owner)).toMatchObject([{
      subject: owner.subject,
      tool: VENDO_TEXT_ME_TOOL,
      automationId: record.id,
      source: "automation",
      duration: "standing",
    }]);

    // The same automation, the same guard — and now the phone rings.
    const rerunId = await vendo.automations.runs.rerun(refusedId!, away);
    const run = await vendo.automations.runs.get(rerunId, away);
    expect(run).toMatchObject({ status: "ok" });
    // The ledger records the send as a step of that firing.
    expect(run?.steps).toMatchObject([{ id: "tell", tool: VENDO_TEXT_ME_TOOL, outcome: "ok" }]);
    // And the console really received it, on the conversation the link row
    // learned from the person's own message.
    expect(cloud.sent[2]).toEqual({ conversationId: CONVERSATION, text: "Your rent cleared.", final: true });
  }, 120_000);

  it("parks a live turn's text behind the same card any other write earns", async () => {
    const cloud = await fakeConsole();
    const vendo = await compose(cloud, "ask");
    await linkAndText(vendo, cloud);

    const outcome = await vendo.guardedTools.execute(
      { id: "call_web", tool: VENDO_TEXT_ME_TOOL, args: { text: "Two invoices are due." } },
      present,
    );

    expect(outcome.status).toBe("pending-approval");
    // Nothing went out while the card is open.
    expect(cloud.sent).toHaveLength(2);
  }, 120_000);

  it("answers an unlinked user with the connect link, never a throw", async () => {
    const cloud = await fakeConsole();
    const vendo = await compose(cloud, "run");

    const outcome = await vendo.guardedTools.execute(
      { id: "call_unlinked", tool: VENDO_TEXT_ME_TOOL, args: { text: "Two invoices are due." } },
      present,
    );

    if (outcome.status !== "error") throw new Error(`expected a plain error result, got ${outcome.status}`);
    expect(outcome.error.code).toBe("not-linked");
    // The SAME link the connect flow hands out, minted for this subject — a
    // live agent can offer it verbatim, and an away run leaves it in the ledger.
    expect(outcome.error.message).toMatch(/sms:\+15550000000\?&body=connect%20%40maple%20[23456789A-Z]{6}/);
    expect(cloud.sent).toHaveLength(0);
  }, 120_000);

  it("says the phone is unreachable when the router cannot deliver", async () => {
    const cloud = await fakeConsole();
    const vendo = await compose(cloud, "run");
    await linkAndText(vendo, cloud);

    cloud.failSends = true;
    const outcome = await vendo.guardedTools.execute(
      { id: "call_lapsed", tool: VENDO_TEXT_ME_TOOL, args: { text: "Two invoices are due." } },
      present,
    );

    if (outcome.status !== "error") throw new Error(`expected a plain error result, got ${outcome.status}`);
    // Never a fabricated success: the model is told the text did NOT arrive.
    expect(outcome.error.message).toContain("did not go through");
    expect(outcome.error.message).toContain("reconnecting their phone");
  }, 120_000);

  it("is absent entirely from a deployment that never asked for texts", async () => {
    const configured = await compose(await fakeConsole());
    expect((await configured.actions.descriptors()).map((tool) => tool.name)).toContain(VENDO_TEXT_ME_TOOL);

    // No adapter, no tool: a host that never opted in must not be offered one
    // whose every call could only refuse.
    const bare = await compose(undefined);
    expect((await bare.actions.descriptors()).map((tool) => tool.name)).not.toContain(VENDO_TEXT_ME_TOOL);
  }, 120_000);
});
