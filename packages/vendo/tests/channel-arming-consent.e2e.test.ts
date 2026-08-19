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
import { READ_ONLY_POWER } from "@vendoai/automations";
import { VENDO_TEXT_ME_TOOL } from "../src/text-me.js";

/**
 * JOB-SHAPED ARMING CONSENT, END TO END OVER THE CHANNEL THAT EXPOSED IT.
 *
 * The failure, live 2026-08-18 on production Maple: a user armed "check my
 * checking balance every 15 minutes and text me" entirely over iMessage. Their
 * YES to the job landed — and arming then minted FOUR more per-tool asks
 * (`vendo_text_me`, `vendo_knowledge_search`, `request_connection`,
 * `list_connections`). Three are read-grade tools a live chat runs without asking
 * anyone, and the fourth was literally in the sentence they typed. Consent was
 * framed per-tool while the person was thinking per-job.
 *
 * What this pins is the whole rule in one flow: the arming ask NAMES the powers
 * that need a human and nothing else, ONE yes mints exactly those, and the reads
 * the host's policy already runs need no grant at all — they simply run at 2am.
 *
 * Nothing is stubbed between the halves: real `createVendo`, real guard, real
 * automations engine, one real PGlite store, the real `cloudTextChannel` client,
 * and an HTTP console standing in for the one half this repo does not own. The
 * grants are read back through the path that actually gates a firing, because a
 * grant row the guard would not honour proves nothing — and the ungranted read is
 * read back the same way, because a read that parks proves the opposite.
 */

const API_KEY = "vk_live_arming_consent";
const owner: Principal = { kind: "user", subject: "user_arming_consent" };
const PHONE = "+15557770789";
const CONVERSATION = "conv_arming_consent";
const BALANCE_TOOL = "maple_accounts_balance";
const BALANCE_TITLE = "Check an account balance";
/** The goal an automation is armed with, and the phrase the probe brain keys the
 *  firing branch off. */
const GOAL = "check my checking balance and text me";
const ARMING_HEADER = "Set this to run on its own — needs your approval";
const POWERS_LINE = "- Powers it will hold: ";
const SET_ASK_HEADER = "needs your permission to run on its own";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

interface FakeConsole {
  baseUrl: string;
  sent: Array<{ conversationId: string; text: string; final?: boolean }>;
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
          identityId: "tid_arming_consent",
          handle: "maple",
          number: "+15550000000",
          connectCommand: "connect @maple",
        }));
        return;
      }
      if (req.url === "/api/v1/channels/text/send") {
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

/** The host's own read, and the observable that says whether it really ran: a
 *  firing that reaches it with no grant of any kind is the point of the change. */
function bankingHost(): { tools: ToolRegistry; reads: number } {
  const state = { reads: 0 };
  const descriptor: ToolDescriptor = {
    name: BALANCE_TOOL,
    title: BALANCE_TITLE,
    description: "Read the balance of one of the customer's accounts",
    inputSchema: { type: "object" },
    risk: "read",
  };
  return {
    get reads() {
      return state.reads;
    },
    tools: {
      async descriptors() {
        return [descriptor];
      },
      async execute() {
        state.reads += 1;
        return { status: "ok", output: { balance: 41_208 } };
      },
    },
  };
}

/** The brain, on both sides of the same composition: it arms when asked to, and
 *  on a firing it does what the goal says — reads the balance, then texts it. One
 *  harness rather than two because the automation has to be armed by the SAME
 *  deployment whose away run later fires it. */
const probe = defineHarness({
  name: "channel-arming-consent-probe",
  async *run(turn) {
    const said = (turn.messages.at(-1)?.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ");
    if (said.includes("arm:")) {
      const armed = await turn.tools.call(VENDO_AUTOMATE_TOOL, {
        when: "*/15 * * * *",
        task: GOAL,
      });
      yield { type: "text", delta: armed.status === "ok" ? "Set — I'll keep an eye on it." : "I couldn't set that up." };
      return;
    }
    if (said.includes("checking balance")) {
      // The READ first — ungranted, and it has to run anyway — then the write the
      // person actually allowed at arming.
      const read = await turn.tools.call(BALANCE_TOOL, {});
      if (read.status !== "ok") {
        yield { type: "text", delta: `read blocked: ${read.status}` };
        return;
      }
      const sent = await turn.tools.call(VENDO_TEXT_ME_TOOL, { text: "Your checking balance is $412.08." });
      yield { type: "text", delta: sent.status === "ok" ? "Texted them." : "Could not text them." };
      return;
    }
    yield { type: "text", delta: "Nothing else is due this week." };
  },
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-arming-consent-"));
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

/** `asksOnReads` is the policy-is-truth switch: the SAME deployment, the same
 *  tools, one rule different. The host's policy is the only thing that decides
 *  which tools the arming ask names. */
async function compose(
  cloud: FakeConsole,
  host: { tools: ToolRegistry },
  options: { asksOnReads?: boolean } = {},
): Promise<Vendo> {
  vi.stubEnv("VENDO_API_KEY", API_KEY);
  vi.stubEnv("VENDO_CLOUD_URL", cloud.baseUrl);
  vi.stubEnv("VENDO_BASE_URL", "https://maple.test");
  const vendo: Vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => owner,
    store: await tempStore(),
    harness: probe as never,
    // Arming future unattended behaviour is a write, so `vendo_automate` itself
    // earns a card — and THAT card is the one consent moment for the whole job.
    guard: guard({
      policy: {
        rules: [
          { match: { risk: "write" }, action: "ask" },
          ...(options.asksOnReads === true ? [{ match: { risk: "read" as const }, action: "ask" as const }] : []),
        ],
      },
    }),
    channels: { text: true },
  } as Parameters<typeof createVendo>[0]);
  vendo.actions.add(host.tools);
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

/** Arm the automation the way the live user did: one text asking for it, then the
 *  arming card. Stops BEFORE the yes so a test can inspect the ask itself. */
async function armingAsk(vendo: Vendo, cloud: FakeConsole): Promise<string> {
  await link(vendo, cloud);
  await inbound(vendo, "evt_arm", `arm: ${GOAL} every 15 minutes`);
  await waitFor(() => cloud.sent.length === 2);
  return cloud.sent[1]!.text;
}

const ctxFor = (sessionId: string): RunContext =>
  ({ principal: owner, venue: "chat", presence: "present", sessionId });

/** Arm, then say YES. Returns the record and every text that went out. */
async function armAndApprove(
  vendo: Vendo,
  cloud: FakeConsole,
): Promise<{ record: AutomationRecord; ctx: RunContext; ask: string }> {
  const ask = await armingAsk(vendo, cloud);
  await inbound(vendo, "evt_arm_yes", "YES");
  // The turn's own words. Nothing must follow them — see the no-second-ask test.
  await waitFor(() => cloud.sent.length >= 3);
  const ctx = ctxFor("sess_arming_consent");
  const records = await vendo.automations.list({ owner: owner.subject }, ctx);
  expect(records).toHaveLength(1);
  return { record: records[0]!, ctx, ask };
}

describe.sequential("job-shaped arming consent, over the channel that armed it", () => {
  it("names the powers on the arming ask itself: acts by name, reads as one phrase", async () => {
    const cloud = await fakeConsole();
    const host = bankingHost();
    const vendo = await compose(cloud, host);
    const ask = await armingAsk(vendo, cloud);

    // The post-#1462 arming card, now carrying what the yes actually hands over.
    // Pinned as WHOLE LINES, in order: this text is the consent boundary, and a
    // `toContain` sweep would not notice the powers line drifting above the
    // schedule or the reply instruction losing its place.
    const lines = ask.split("\n");
    expect(lines[0]).toBe(`${ARMING_HEADER}:`);
    expect(lines[1]).toBe("- When it runs: every 15 minutes (*/15 * * * *)");
    expect(lines[2]).toBe(`- What to do on every firing: ${GOAL}`);
    expect(lines[3]!.startsWith(POWERS_LINE)).toBe(true);
    expect(lines[4]).toBe("Reply YES to approve, or NO to cancel.");
    expect(lines).toHaveLength(5);

    const powers = lines[3]!;
    // What the automation DOES, named one by one — including the thing the person
    // asked for in their own sentence.
    expect(powers).toContain("Text me");
    // THE POINT. Every read it may make is ONE phrase, at the end. Naming reads
    // individually is what turned a yes to a JOB into a wall of tool names the
    // person could not act on — three of the four follow-up asks in the live
    // incident were reads. They are still granted; they are not worth a line each.
    expect(powers.endsWith(READ_ONLY_POWER)).toBe(true);
    expect(powers).not.toContain(BALANCE_TITLE);
    expect(ask).not.toContain(BALANCE_TITLE);
    // Exactly one read phrase, however many reads the deployment has.
    expect(powers.split(READ_ONLY_POWER)).toHaveLength(2);

    // Design §3's voice law: no identifier and no machinery reaches the person.
    expect(ask).not.toContain("vendo_");
    expect(ask).not.toContain(BALANCE_TOOL);
    expect(ask).not.toContain("gset_");
  }, 120_000);

  it("carries the named powers on the approval RECORD, not in any one surface", async () => {
    const cloud = await fakeConsole();
    const host = bankingHost();
    const vendo = await compose(cloud, host);
    const ask = await armingAsk(vendo, cloud);

    // The universal seam: the set is computed once, at park time, and rides on the
    // approval. The text renders it; every other surface reads the same field. A
    // powers list that lived in the channel would be a promise only texting users
    // could ever be shown.
    const pending = await vendo.guard.approvals.pending(owner);
    const arming = pending.find((request) => request.call.tool === VENDO_AUTOMATE_TOOL);
    expect(arming).toBeDefined();
    expect(arming!.powers).toBeDefined();
    expect(arming!.powers).toContain("Text me");
    expect(arming!.powers).not.toContain(BALANCE_TITLE);
    // Titles, never identifiers — the field is rendered verbatim by whoever reads it.
    for (const power of arming!.powers!) expect(power).not.toMatch(/^[a-z_]+_[a-z_]+$/);

    // And the text said exactly what the record carries: one computation, so the
    // card and the run cannot disagree.
    const powers = ask.split("\n").find((line) => line.startsWith(POWERS_LINE))!;
    expect(powers).toBe(`${POWERS_LINE}${arming!.powers!.join(", ")}`);
  }, 120_000);

  it("turns ONE yes into exactly those standing grants, with nothing left pending", async () => {
    const cloud = await fakeConsole();
    const host = bankingHost();
    const vendo = await compose(cloud, host);
    const { record } = await armAndApprove(vendo, cloud);

    // Armed, and every named power is already a live standing grant the guard will
    // honour away. No second ceremony happened.
    expect(record.armed).toBe(true);
    const grants = await vendo.guard.grants.list(owner);
    const mine = grants.filter((grant) => grant.automationId === record.id);
    expect(mine.length).toBeGreaterThan(0);
    for (const grant of mine) {
      expect(grant).toMatchObject({
        subject: owner.subject,
        automationId: record.id,
        source: "automation",
        duration: "standing",
      });
    }
    // THE RESHAPE'S CORE CLAIM: one yes covers the whole JOB. The write the person
    // asked for by name AND the read they never had to think about are both live
    // standing grants now, so the firing holds everything it needs and nobody is
    // asked a second time. Away execution is grant-backed exactly as it always was
    // (05 §6 untouched) — what changed is that the person answers once.
    expect(mine.map((grant) => grant.tool)).toContain(VENDO_TEXT_ME_TOOL);
    expect(mine.map((grant) => grant.tool)).toContain(BALANCE_TOOL);

    // NOTHING is pending for this automation — this is the live failure, inverted.
    const pending = await vendo.guard.approvals.pending(owner);
    expect(pending.filter((ask) => ask.ctx.trigger?.automationId === record.id)).toEqual([]);
  }, 120_000);

  it("never sends a follow-up permission text, however many turns go by", async () => {
    const cloud = await fakeConsole();
    const host = bankingHost();
    const vendo = await compose(cloud, host);
    await armAndApprove(vendo, cloud);

    // An ordinary turn about something else entirely. After a normal arming there
    // is nothing outstanding, so the set ask has nothing to offer and must stay
    // silent — the second consent moment is gone, not merely shorter.
    await inbound(vendo, "evt_later", "what did I spend on food?");
    await waitFor(() => cloud.sent.at(-1)!.text === "Nothing else is due this week.");

    expect(cloud.sent.filter((text) => text.text.includes(SET_ASK_HEADER))).toEqual([]);
  }, 120_000);

  it("really fires: the read and the text both land on grants that one yes minted", async () => {
    const cloud = await fakeConsole();
    const host = bankingHost();
    const vendo = await compose(cloud, host);
    const { record, ctx } = await armAndApprove(vendo, cloud);
    const before = host.reads;
    const landed = cloud.sent.length;

    // THE POINT, at 2am. Both halves of the job run on standing grants the single
    // arming YES minted — the read the person never had to think about, and the
    // text they asked for by name. Away execution is grant-backed exactly as it has
    // always been (05 §6 untouched); what changed is that nobody had to answer a
    // second round of per-tool asks to get here.
    const [fired] = await vendo.automations.tick(new Date(Date.now() + 30 * 60_000));
    expect(fired).toBeDefined();
    expect(await vendo.automations.runs.get(fired!, ctx)).toMatchObject({
      automationId: record.id,
      status: "ok",
    });
    expect(host.reads).toBe(before + 1);
    expect(cloud.sent.slice(landed)).toEqual([
      { conversationId: CONVERSATION, text: "Your checking balance is $412.08.", final: true },
    ]);
  }, 120_000);

  it("folds EVERY read into the one phrase, whatever the host's policy says", async () => {
    const cloud = await fakeConsole();
    const host = bankingHost();
    // A host that confirms reads in live chat. The grouping is not a policy
    // decision — an automation runs on captured grants, so its reads are granted
    // either way; what the person is shown is a property of the CARD, and a card
    // that reads well under one policy must read the same under another.
    const vendo = await compose(cloud, host, { asksOnReads: true });
    const ask = await armingAsk(vendo, cloud);

    const powers = ask.split("\n").find((line) => line.startsWith(POWERS_LINE))!;
    expect(powers.endsWith(READ_ONLY_POWER)).toBe(true);
    expect(powers.split(READ_ONLY_POWER)).toHaveLength(2);
    expect(powers).not.toContain(BALANCE_TITLE);
    expect(ask).not.toContain(BALANCE_TOOL);
  }, 120_000);
});
