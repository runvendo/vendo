import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  VENDO_AUTOMATE_TOOL,
  type AutomationRecord,
  type Principal,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelInboundSecret } from "../src/channels.js";
import { createVendo, guard, type Vendo } from "../src/server.js";
import { VENDO_TEXT_ME_TOOL } from "../src/text-me.js";

/**
 * AN OUTSTANDING GRANT SET, ASKED OVER TEXT, ALL THE WAY TO A FIRING THAT
 * DELIVERS.
 *
 * The gap this pins, live 2026-08-18 on production Maple: a user armed "check my
 * checking balance every 15 minutes and text me" entirely over iMessage, and
 * arming minted pending standing-grant captures. Those asks are approval rows the
 * engine writes during the authoring call, not stream parts, so they had exactly
 * one surface: the host app's web approvals feed. A text-only user could never
 * reach it, so every firing ran without the Text me grant and the agent could only
 * say "there are still some permissions pending approval". This one text is how
 * they get asked.
 *
 * WHAT CHANGED under it (job-shaped arming consent, same day): a normal arming no
 * longer leaves anything pending. The powers are named on the authoring call's own
 * approval and one yes mints them, so there is nothing for this text to offer —
 * `channel-arming-consent.e2e.test.ts` pins that, including that no follow-up text
 * is sent. The set ask is now the LEFTOVER path, and this file exercises the
 * leftover that actually happens: an arming the host's policy ran WITHOUT asking
 * anybody, which is `vendo_make`'s read-graded arming and any host whose policy
 * lets authoring through. Nobody saw a powers line, so nothing may be minted off
 * it, and each power is captured as a pending ask exactly as before.
 *
 * Nothing is stubbed between the two halves: real `createVendo`, real guard, real
 * automations engine, one real PGlite store, the real `cloudTextChannel` client,
 * and an HTTP console standing in for the one half this repo does not own. The
 * grants are read back through the path that actually gates a firing — the away
 * run's own call to `vendo_text_me` reaching the console — because a grant row
 * that the guard would not honour proves nothing.
 */

const API_KEY = "vk_live_grant_set";
const owner: Principal = { kind: "user", subject: "user_grant_set" };
const PHONE = "+15557770456";
const CONVERSATION = "conv_grant_set";
const BALANCE_TOOL = "maple_accounts_balance";
/** The goal an automation is armed with, and the phrase the probe brain keys the
 *  firing branch off. */
const GOAL = "check my checking balance and text me";
const SET_ASK_HEADER = "needs your permission to run on its own";
const SET_ALLOWED_TEXT = "Done — it can run on its own now.";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

interface FakeConsole {
  baseUrl: string;
  sent: Array<{ conversationId: string; text: string }>;
}

async function fakeConsole(): Promise<FakeConsole> {
  const state: FakeConsole = { baseUrl: "", sent: [] };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/channels/text/register") {
        res.end(JSON.stringify({
          identityId: "tid_grant_set",
          handle: "maple",
          number: "+15550000000",
          connectCommand: "connect @maple",
        }));
        return;
      }
      if (req.url === "/api/v1/channels/text/send") {
        state.sent.push(JSON.parse(body) as { conversationId: string; text: string });
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

/** One read the host owns, so the goal's consent surface is more than Vendo's own
 *  tools — the set ask has to name every one of them. */
function bankingHost(): ToolRegistry {
  const descriptor: ToolDescriptor = {
    name: BALANCE_TOOL,
    title: "Check an account balance",
    description: "Read the balance of one of the customer's accounts",
    inputSchema: { type: "object" },
    risk: "read",
  };
  return {
    async descriptors() {
      return [descriptor];
    },
    async execute() {
      return { status: "ok", output: { balance: 41_208 } };
    },
  };
}

/** The brain, on both sides of the same composition: it arms when asked to, it
 *  texts when a firing hands it the goal, and it just answers otherwise. One
 *  harness rather than three because the automation has to be armed by the SAME
 *  deployment whose away run later fires it. */
const probe = defineHarness({
  name: "channel-grant-set-probe",
  async *run(turn) {
    const said = (turn.messages.at(-1)?.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ");
    if (said.includes("arm:")) {
      const armed = await turn.tools.call(VENDO_AUTOMATE_TOOL, { when: { event: "balance.checked" }, task: GOAL });
      yield { type: "text", delta: armed.status === "ok" ? "Set — I'll keep an eye on it." : "I couldn't set that up." };
      return;
    }
    if (said.includes("checking balance")) {
      const sent = await turn.tools.call(VENDO_TEXT_ME_TOOL, { text: "Your checking balance is $412.08." });
      yield { type: "text", delta: sent.status === "ok" ? "Texted them." : "Could not text them." };
      return;
    }
    yield { type: "text", delta: "Nothing else is due this week." };
  },
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-grant-set-"));
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

async function compose(cloud: FakeConsole): Promise<Vendo> {
  vi.stubEnv("VENDO_API_KEY", API_KEY);
  vi.stubEnv("VENDO_CLOUD_URL", cloud.baseUrl);
  vi.stubEnv("VENDO_BASE_URL", "https://maple.test");
  const vendo: Vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => owner,
    store: await tempStore(),
    harness: probe as never,
    // A host whose policy lets AUTHORING through without a card, but still wants
    // its writes confirmed. That combination is the whole subject of this file:
    // nobody was ever shown a powers line for this arming, so nothing may be
    // minted off one, and every power the automation needs is left as a pending
    // ask for the text below to deliver.
    guard: guard({
      policy: {
        rules: [
          { match: { tool: VENDO_AUTOMATE_TOOL }, action: "run" },
          { match: { risk: "write" }, action: "ask" },
        ],
      },
    }),
    channels: { text: true },
  } as Parameters<typeof createVendo>[0]);
  vendo.actions.add(bankingHost());
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

/** A linked, texting user — the code off the link page, then nothing else. */
async function link(vendo: Vendo, cloud: FakeConsole): Promise<void> {
  const page = await (await vendo.handler(
    new Request("https://maple.test/api/vendo/channels/text/link", { headers: { "user-agent": "Macintosh" } }),
  )).text();
  await inbound(vendo, "evt_link", /connect @maple ([23456789A-Z]{6})/.exec(page)![1]!);
  await waitFor(() => cloud.sent.length === 1);
}

/** Arm the automation over text under a policy that does NOT card the authoring
 *  call: one text asking for it, the turn's own words, and then the set ask for
 *  everything still outstanding. No arming card, and nothing minted without one. */
async function armOverText(
  vendo: Vendo,
  cloud: FakeConsole,
): Promise<{ record: AutomationRecord; ctx: RunContext; setAsk: string }> {
  await link(vendo, cloud);
  await inbound(vendo, "evt_arm", `arm: ${GOAL} every 15 minutes`);
  // The turn's own words, and then the set ask behind them. The authoring call
  // itself never parks here, so there is no card in between — which is exactly
  // why the powers had to be captured instead of minted.
  await waitFor(() => cloud.sent.length === 3);
  expect(cloud.sent.every((text) => !text.text.includes("needs your approval"))).toBe(true);

  const ctx: RunContext = { principal: owner, venue: "chat", presence: "present", sessionId: "sess_grant_set" };
  const records = await vendo.automations.list({ owner: owner.subject }, ctx);
  expect(records).toHaveLength(1);
  return { record: records[0]!, ctx, setAsk: cloud.sent[2]!.text };
}

describe.sequential("an automation's grant set, asked over text", () => {
  it("asks for the whole set in ONE text, by title, after the arming turn", async () => {
    const cloud = await fakeConsole();
    const vendo = await compose(cloud);
    const { record, setAsk } = await armOverText(vendo, cloud);

    // Every ask arming raised is still pending — nothing about the set ask
    // decides anything — and the text names every one of them.
    const pending = await vendo.guard.approvals.pending(owner);
    const captures = pending.filter((ask) => ask.ctx.trigger?.automationId === record.id);
    expect(captures.length).toBeGreaterThan(1);

    expect(setAsk.startsWith(`${GOAL} — ${SET_ASK_HEADER}:`)).toBe(true);
    for (const ask of captures) {
      expect(setAsk).toContain(`\n- ${ask.descriptor.title ?? ask.descriptor.name}`);
    }
    // The one the live incident lost: without it the automation can never reach
    // the phone it was armed from.
    expect(setAsk).toContain("\n- Text me");
    // The read is named here, one line of its own, and that is the leftover path
    // showing its age: this text is a raw list of every outstanding capture,
    // because nobody was shown a powers page for this arming at all. A chat arming
    // gets the grouped one-line version instead (channel-arming-consent.e2e).
    expect(setAsk).toContain("\n- Check an account balance");
    expect(setAsk).toContain("Reply YES to allow all of these, or NO to cancel it.");
    // Design §3's voice law: no identifier, and no machinery, reaches the person.
    expect(setAsk).not.toContain("vendo_");
    expect(setAsk).not.toContain(BALANCE_TOOL);
    expect(setAsk).not.toContain("gset_");
    expect(setAsk).not.toContain("{");

    // ONE text for the whole set, not one per capture — which is the entire
    // reason a grant SET exists.
    expect(cloud.sent.filter((text) => text.text.includes(SET_ASK_HEADER))).toHaveLength(1);
  }, 120_000);

  it("turns one YES into every standing grant, and the next firing really texts", async () => {
    const cloud = await fakeConsole();
    const vendo = await compose(cloud);
    const { record, ctx } = await armOverText(vendo, cloud);
    const before = cloud.sent.length;

    await inbound(vendo, "evt_set_yes", "YES");
    await waitFor(() => cloud.sent.length > before);

    // Every capture in the set settled: no ask of this automation's is left
    // pending, and each one is now a live standing grant the guard will honour
    // away.
    const stillPending = await vendo.guard.approvals.pending(owner);
    expect(stillPending.filter((ask) => ask.ctx.trigger?.automationId === record.id)).toEqual([]);
    const grants = await vendo.guard.grants.list(owner);
    expect(grants.length).toBeGreaterThan(1);
    for (const grant of grants) {
      expect(grant).toMatchObject({
        subject: owner.subject,
        automationId: record.id,
        source: "automation",
        duration: "standing",
      });
    }
    expect(grants.map((grant) => grant.tool)).toContain(VENDO_TEXT_ME_TOOL);
    expect(cloud.sent.at(-1)!.text).toBe("Done — it can run on its own now.");

    // THE POINT. An away firing of the automation they armed from their phone
    // now reaches that phone — through the away runner, the guard's away
    // authority check, the real `vendo_text_me`, and the console's own send
    // route. A grant row the guard would not honour would leave this silent.
    const landed = cloud.sent.length;
    const [runId] = await vendo.emit("balance.checked", {}, owner);
    expect(await vendo.automations.runs.get(runId!, ctx)).toMatchObject({
      automationId: record.id,
      status: "ok",
    });
    expect(cloud.sent.slice(landed)).toEqual([
      { conversationId: CONVERSATION, text: "Your checking balance is $412.08." },
    ]);
  }, 120_000);

  it("turns a NO into the disarm a bare no has always meant, and says so", async () => {
    const cloud = await fakeConsole();
    const vendo = await compose(cloud);
    const { record, ctx } = await armOverText(vendo, cloud);
    expect(record.armed).toBe(true);
    const before = cloud.sent.length;

    await inbound(vendo, "evt_set_no", "no");
    await waitFor(() => cloud.sent.length > before);

    // `handleDecision`'s deny half (automations `consent.ts`): a consent moment
    // that ended with NOTHING granted turns the record off. Nothing is minted,
    // and the person is told which of the two things happened.
    expect(await vendo.automations.get(record.id, ctx)).toMatchObject({ armed: false });
    expect(await vendo.guard.grants.list(owner)).toEqual([]);
    expect(cloud.sent.at(-1)!.text).toBe("Okay — I turned it off.");
  }, 120_000);

  it("asks again over text when a FIRING meets a power the automation no longer holds", async () => {
    const cloud = await fakeConsole();
    const vendo = await compose(cloud);
    const { record } = await armOverText(vendo, cloud);

    // Settle the set the ordinary way, and prove the automation really works.
    await inbound(vendo, "evt_set_yes", "YES");
    await waitFor(() => cloud.sent.at(-1)!.text === SET_ALLOWED_TEXT);
    let landed = cloud.sent.length;
    await vendo.emit("balance.checked", {}, owner);
    expect(cloud.sent.slice(landed)).toEqual([
      { conversationId: CONVERSATION, text: "Your checking balance is $412.08." },
    ]);

    // Then the person takes the Text me permission back. THE OTHER HALF of the
    // leftover path: a firing that meets an ask-grade tool it holds no grant for
    // does not quietly skip it — the guard parks the call and the ask it mints is
    // an automation-venue row, so the next texted turn offers it as a set again.
    // Nothing else closes that ask; before the set text existed, only the web feed
    // could.
    for (const grant of await vendo.guard.grants.list(owner)) {
      if (grant.tool === VENDO_TEXT_ME_TOOL) await vendo.guard.grants.revoke(grant.id, owner);
    }
    landed = cloud.sent.length;
    await vendo.emit("balance.checked", {}, owner);
    // The firing reached the phone with nothing, because the permission is gone.
    expect(cloud.sent.slice(landed)).toEqual([]);
    const parked = (await vendo.guard.approvals.pending(owner))
      .filter((ask) => ask.ctx.trigger?.automationId === record.id);
    expect(parked.map((ask) => ask.call.tool)).toContain(VENDO_TEXT_ME_TOOL);

    // And the next ordinary turn asks for it, by title, exactly as arming's set
    // did. Scoped to what this turn sent: an earlier set ask is still in the
    // history, and matching that one would prove nothing.
    const mark = cloud.sent.length;
    await inbound(vendo, "evt_after_revoke", "anything due this week?");
    await waitFor(() => cloud.sent.slice(mark).some((text) => text.text.includes(SET_ASK_HEADER)));
    expect(cloud.sent.slice(mark).find((text) => text.text.includes(SET_ASK_HEADER))!.text)
      .toContain("\n- Text me");

    // One more YES and the automation reaches the phone again — through the away
    // authority check and the real console send, not a grant row nobody honours.
    await inbound(vendo, "evt_regrant_yes", "YES");
    await waitFor(() => cloud.sent.at(-1)!.text === SET_ALLOWED_TEXT);
    landed = cloud.sent.length;
    await vendo.emit("balance.checked", {}, owner);
    expect(cloud.sent.slice(landed)).toEqual([
      { conversationId: CONVERSATION, text: "Your checking balance is $412.08." },
    ]);
  }, 120_000);

  it("never asks the same set twice, however many turns go by", async () => {
    const cloud = await fakeConsole();
    const vendo = await compose(cloud);
    await armOverText(vendo, cloud);

    // An ordinary turn about something else entirely. The set is still
    // outstanding — the person simply has not answered — and re-asking it every
    // turn is how this feature would become the thing they mute.
    await inbound(vendo, "evt_later", "what did I spend on food?");
    await waitFor(() => cloud.sent.at(-1)!.text === "Nothing else is due this week.");

    expect(cloud.sent.filter((text) => text.text.includes(SET_ASK_HEADER))).toHaveLength(1);
  }, 120_000);
});
