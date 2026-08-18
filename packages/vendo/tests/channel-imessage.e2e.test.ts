import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Principal, VendoLogEvent } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelInboundSecret } from "../src/channels.js";
import { createVendo, type Vendo } from "../src/server.js";

/**
 * HOW A TEXTED REPLY ARRIVES — the four things that decide whether this channel
 * feels like a person texting back or like a form submission.
 *
 * Every case below drives the REAL path end to end: a real inbound delivery
 * through the real wire, the real harness stream, the real channel adapter, and
 * a real HTTP console on the other side. Nothing on either side of the seam is
 * stubbed — a divider that never reaches the adapter, or a retry that only the
 * adapter believes in, would both pass a mocked version of this file.
 */

const API_KEY = "vk_live_channel_imessage";
const principal: Principal = { kind: "user", subject: "user_imessage" };
const PHONE = "+15558880123";
const CONVERSATION = "conv_imessage";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

/** `attempts` counts every delivery the channel TRIED, `sent` only the ones that
    landed — the two diverge while `failSends` is on, which is how a case says
    "the console was down exactly when the reply went out". */
interface FakeConsole {
  baseUrl: string;
  sent: Array<{ conversationId: string; text: string }>;
  attempts: number;
  failSends: boolean;
}

async function fakeConsole(): Promise<FakeConsole> {
  const state: FakeConsole = { baseUrl: "", sent: [], attempts: 0, failSends: false };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/channels/text/register") {
        res.end(JSON.stringify({
          identityId: "tid_imessage",
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

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-channel-imessage-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** No wall-clock budget on purpose: the test's own timeout is the hang
    detector, and a tighter inner bound would report a product bug whenever the
    machine is merely busy. */
async function waitFor(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 25));
}

/** A deployment wired to the fake console, plus the two things a case drives it
 *  with: an inbound delivery, and the link that makes the phone a known user. */
async function deployment(harness: unknown, logged?: VendoLogEvent[]): Promise<{
  cloud: FakeConsole;
  text: (eventId: string, body: string) => Promise<Response>;
  link: (eventId: string) => Promise<void>;
  vendo: Vendo;
}> {
  const cloud = await fakeConsole();
  vi.stubEnv("VENDO_API_KEY", API_KEY);
  vi.stubEnv("VENDO_CLOUD_URL", cloud.baseUrl);
  vi.stubEnv("VENDO_BASE_URL", "https://maple.test");
  const vendo: Vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store: await tempStore(),
    harness: harness as never,
    channels: { text: true },
    // The host's own log sink — the seam a deployment routes Vendo into its
    // observability with, and the only way to READ what Vendo said out loud.
    ...(logged === undefined ? {} : { logger: (event: VendoLogEvent) => logged.push(event) }),
  } as Parameters<typeof createVendo>[0]);

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
        conversationId: CONVERSATION,
        receivedAt: new Date().toISOString(),
      }),
    }));

  // Link the phone the way a person does: mint a code, then text it back.
  const link = async (eventId: string): Promise<void> => {
    const page = await (await vendo.handler(
      new Request("https://maple.test/api/vendo/channels/text/link", { headers: { "user-agent": "Macintosh" } }),
    )).text();
    await text(eventId, /connect @maple ([23456789A-Z]{6})/.exec(page)![1]!);
    await waitFor(() => cloud.sent.length === 1);
  };

  return { cloud, text, link, vendo };
}

/** Every run the harness was put through, warm turns included — `thr_warm` is
 *  how a warm turn names its throwaway thread (harness-turn.ts). */
interface Run {
  threadId: string;
  messages: number;
}

describe.sequential("how a texted reply arrives", () => {
  it("sends each text the moment its divider passes, and never sends the divider", async () => {
    // THE POINT: a reply the model wrote as two texts has to LAND as two texts,
    // the first one while the second is still being written. Buffering the whole
    // turn and sending one message at the end is the behaviour this replaces —
    // it reads as a form submission, not as somebody texting back.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Warming runs only once the whole reply has drained, so it is this case's
    // "the turn is finished" signal — which is what lets it assert that a text
    // was NOT sent without racing the stream.
    let warmed = false;
    const { cloud, text, link } = await deployment(defineHarness({
      name: "channel-divider-probe",
      async *run(turn) {
        // The warm turn runs this same harness on a throwaway thread; it must
        // not sit on the gate, and nothing it says is ever delivered.
        if (turn.threadId.startsWith("thr_warm")) {
          warmed = true;
          yield { type: "text", delta: "warm" };
          return;
        }
        yield { type: "text", delta: "On it." };
        yield { type: "text", delta: "\n---\n" };
        await gate;
        yield { type: "text", delta: "You spent $412 on food." };
        // A model that signs off with a divider and no newline after it. The
        // stream simply ends there, so the last line never gets terminated —
        // and a divider is a cut point in that position too, never a text.
        yield { type: "text", delta: "\n---" };
      },
    }));
    await link("evt_link_divider");

    await text("evt_divider", "what did I spend on food?");

    // The first text is already on the phone while the model is still writing
    // the second — this is the whole latency win, and it cannot be faked by a
    // buffered implementation.
    await waitFor(() => cloud.sent.length === 2);
    expect(cloud.sent[1]).toEqual({ conversationId: CONVERSATION, text: "On it." });

    release();

    await waitFor(() => cloud.sent.length === 3);
    expect(cloud.sent[2]).toEqual({ conversationId: CONVERSATION, text: "You spent $412 on food." });
    // The divider is a cut point, not content: it is stripped from what goes
    // out, and a trailing one adds no fourth text of its own.
    await waitFor(() => warmed);
    expect(cloud.sent).toHaveLength(3);
    for (const message of cloud.sent) expect(message.text).not.toContain("---");
  }, 120_000);

  it("retries a reply the console drops, and says out loud when it is lost", async () => {
    // THE POINT: a single 503 used to lose the person's answer silently and
    // forever — the turn had already run its tool calls, so nothing could be
    // replayed. A blip is now retried, and a reply that still cannot be
    // delivered is an operator-visible event rather than a shrug.
    const logged: VendoLogEvent[] = [];
    const { cloud, text, link } = await deployment(defineHarness({
      name: "channel-retry-probe",
      async *run() {
        yield { type: "text", delta: "You spent $412 on food." };
      },
    }), logged);
    await link("evt_link_retry");

    cloud.failSends = true;
    await text("evt_retry", "what did I spend on food?");

    await waitFor(() => logged.some((event) => event.code === "vendo.channel-reply-lost"));
    // One attempt plus three retries for the reply, on top of the link's ack.
    expect(cloud.attempts).toBe(5);
    expect(cloud.sent).toHaveLength(1);
    const lost = logged.find((event) => event.code === "vendo.channel-reply-lost")!;
    expect(lost.level).toBe("error");
    expect(lost.message).toContain(CONVERSATION);
  }, 120_000);

  it("keeps two rapid texts on one thread, the second after the first", async () => {
    // THE POINT: two texts a second apart used to run as two concurrent turns.
    // Both read the link before either wrote its thread back, so each minted its
    // own — a forked conversation where the second reply has no idea what the
    // person just said, and one of the two threads is orphaned on the next text.
    const runs: Run[] = [];
    const { cloud, text, link } = await deployment(defineHarness({
      name: "channel-serial-probe",
      async *run(turn) {
        runs.push({ threadId: turn.threadId, messages: turn.messages.length });
        yield { type: "text", delta: `ok ${runs.length}` };
      },
    }));
    await link("evt_link_serial");

    // Genuinely concurrent: the wire acks each delivery and runs it detached, so
    // neither of these awaits the turn it started.
    await Promise.all([text("evt_first", "what did I spend on food?"), text("evt_second", "and on rent?")]);

    await waitFor(() => cloud.sent.length === 3);
    const conversation = runs.filter((run) => !run.threadId.startsWith("thr_warm"));
    expect(conversation).toHaveLength(2);
    // ONE thread, and the second turn can see the first exchange on it — which
    // is only possible if it ran after the first finished writing.
    expect(conversation[1]!.threadId).toBe(conversation[0]!.threadId);
    expect(conversation[1]!.messages).toBeGreaterThan(conversation[0]!.messages);
  }, 120_000);

  it("warms the provider cache once the reply is out, so the next text starts warm", async () => {
    // THE POINT: warming already existed for the web (wire/threads.ts fires it
    // when a chat surface opens) and a texted conversation never got it, so
    // every text in a back-and-forth paid a cold prefix. The warm turn runs
    // AFTER the reply — it must never be something the person waits behind.
    const runs: Run[] = [];
    const { cloud, text, link } = await deployment(defineHarness({
      name: "channel-warm-probe",
      async *run(turn) {
        runs.push({ threadId: turn.threadId, messages: turn.messages.length });
        yield { type: "text", delta: "You spent $412 on food." };
      },
    }));
    await link("evt_link_warm");

    await text("evt_warm", "what did I spend on food?");
    await waitFor(() => cloud.sent.length === 2);

    await waitFor(() => runs.some((run) => run.threadId.startsWith("thr_warm")));
    // Warming is a throwaway turn: it leaves no transcript and nothing it says
    // is ever delivered to the phone.
    expect(cloud.sent).toHaveLength(2);
  }, 120_000);
});
