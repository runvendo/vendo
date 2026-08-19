/**
 * The turn contract — `chat()` and `run()` answering the one `TurnResult`.
 *
 * Real embedded store, real guard, real `createHarnessRuntime`; only the thinker
 * is scripted, because the thinker is not what is under test (CLAUDE.md: test
 * the SEAM). Everything a caller is promised about a turn is proved through the
 * real write path and read back through the real read path.
 */
import { VendoError, type ToolResult } from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { APPROVAL_WAIT_MS, defineHarness } from "@vendoai/harnesses";
import { createStore, threadMessageStore, type VendoStore } from "@vendoai/store";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { agent, type VendoAgent } from "../src/agent.js";
import type { RunEvent } from "../src/turn.js";
import { tool } from "../src/tools.js";

let stores = 0;
const memoryStore = (): VendoStore => createStore({ dataDir: `memory://agents-turn-${stores++}` });

/** Ungraded/destructive is the one thing a guard with no rules at all still
 *  wants a person for (`#defaultPosture`), in either venue — so this is how a
 *  turn parks without a rule set standing in for the guard. */
const refundTool = (ran: { count: number }) => tool({
  name: "refund",
  description: "Refund an invoice",
  risk: "destructive",
  inputSchema: { type: "object" },
  execute: () => {
    ran.count += 1;
    return { refunded: true };
  },
});

const owner = (subject: string) => ({ kind: "user" as const, subject });

/** The whole transcript, through the same read path a reload takes. */
const transcriptOf = (store: VendoStore, subject: string, threadId: string): Promise<UIMessage[]> =>
  threadMessageStore<UIMessage>(store).list(owner(subject), threadId as never);

const collect = async (events: AsyncIterable<RunEvent>): Promise<RunEvent[]> => {
  const seen: RunEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};

const speaker = (text: string) => defineHarness({
  name: "speaker",
  async *run() {
    yield { type: "text" as const, delta: text };
  },
});

describe("the turn is the drainer of record", () => {
  it("persists a turn nobody awaited and nobody tapped", async () => {
    const store = memoryStore();
    const support = agent({ name: "support", harness: speaker("Filed under done."), store });

    // Neither awaited nor read: exactly what a caller who only wanted the work
    // done writes. The turn still has to happen, in full.
    const turn = support.chat("File the report.", { as: "u_42" });

    await expect.poll(
      async () => (await transcriptOf(store, "u_42", turn.threadId)).map((message) => message.role),
      { timeout: 20_000, interval: 25 },
    ).toEqual(["user", "assistant"]);
    const transcript = await transcriptOf(store, "u_42", turn.threadId);
    expect(JSON.stringify(transcript.at(-1)?.parts)).toContain("Filed under done.");
  }, 20_000);

  it("refuses a second reader, and finishes for a turn whose events nobody reads", async () => {
    const support = agent({ name: "support", harness: speaker("done"), store: memoryStore() });

    const turn = support.chat("go", { as: "u_42" });
    expect(await collect(turn.events)).toContainEqual({ type: "text", delta: "done" });
    await turn;
    const second = await collect(turn.events).catch((error: unknown) => error);

    expect(second).toBeInstanceOf(VendoError);
    expect((second as VendoError).code).toBe("validation");

    const unread = support.chat("go again", { as: "u_42" });
    expect(await unread).toMatchObject({ status: "ok", text: "done" });
  });
});

describe("a turn's ids", () => {
  it("are readable before it completes, and are the ones the result carries", async () => {
    const support = agent({ name: "support", harness: speaker("done"), store: memoryStore() });

    const turn = support.chat("go", { as: "u_42" });
    expect(turn.threadId).toMatch(/^thr_/);
    expect(turn.turnId).toMatch(/^trn_/);

    expect(await turn).toMatchObject({ status: "ok", threadId: turn.threadId, turnId: turn.turnId });
  });

  it("are on the arm a broken turn answers with too", async () => {
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "breaks",
        async *run() {
          yield { type: "error" as const, message: "The ledger is unreachable." };
        },
      }),
      store: memoryStore(),
    });

    const turn = support.chat("go", { as: "u_42" });
    const result = await turn;

    expect(result).toMatchObject({
      status: "error",
      // §1.5: a turn that broke never spoke, so the sentence lives in the error.
      text: "",
      threadId: turn.threadId,
      turnId: turn.turnId,
      error: { message: "The ledger is unreachable." },
    });
  });

  it("names the turn on the rows the turn wrote, so a caller can join them", async () => {
    const store = memoryStore();
    const guard = createGuard({ store });
    const turn = agent({
      name: "support",
      // Spend is what mints the turn's run row (`runAuditEvent`), so the thinker
      // has to meter something for there to be a row to join.
      harness: defineHarness({
        name: "meters",
        async *run() {
          yield { type: "usage" as const, inputTokens: 3, outputTokens: 1 };
          yield { type: "text" as const, delta: "done" };
        },
      }),
      guard,
      store,
    }).chat("go", { as: "u_42" });
    await turn;

    const { events } = await guard.audit.query({ principal: owner("u_42") });
    expect(events.map((event) => event.turnId)).toContain(turn.turnId);
  });
});

describe("the thread a turn runs on", () => {
  const peeker = (seen: { messages: number }) => defineHarness({
    name: "peek",
    async *run(turn) {
      seen.messages = turn.messages.length;
      yield { type: "text" as const, delta: "ok" };
    },
  });

  it("is new when the id is omitted, and the same one when it is handed back", async () => {
    const seen = { messages: 0 };
    const support = agent({ name: "support", harness: peeker(seen), store: memoryStore() });

    const first = support.chat("first", { as: "u_42" });
    await first;
    const fresh = support.chat("second", { as: "u_42" });
    await fresh;
    expect(fresh.threadId).not.toBe(first.threadId);
    expect(seen.messages).toBe(1);

    await support.chat("carry on", { as: "u_42", threadId: first.threadId });
    expect(seen.messages).toBe(3); // user, assistant, user
  });

  it("refuses an explicitly-undefined id rather than quietly forking the conversation", () => {
    const support = agent({ name: "support", harness: speaker("ok"), store: memoryStore() });
    // What a host actually writes: an id read off a record that was not there.
    const remembered: { threadId?: string } = {};

    const forked = (): unknown => support.chat("go", { as: "u_42", threadId: remembered.threadId });

    expect(forked).toThrow(VendoError);
    expect(forked).toThrow(/threadId was passed as undefined/);
  });
});

describe("a park ENDS the turn", () => {
  /** A thinker that asks for the refund on its first turn and reports on its
   *  second — which is exactly what a resumed turn is. */
  const refunder = (asked: { reason: string }) => {
    let turns = 0;
    return defineHarness({
      name: "refunder",
      async *run(turn) {
        turns += 1;
        if (turns > 1) {
          yield { type: "text" as const, delta: "The refund went through." };
          return;
        }
        const result: ToolResult = await turn.tools.call("refund", {});
        asked.reason = result.status === "denied" ? result.reason : result.status;
        yield { type: "text" as const, delta: "I have asked for approval." };
      },
    });
  };

  const parking = (store: VendoStore, ran: { count: number }, asked: { reason: string }): VendoAgent =>
    agent({ name: "support", harness: refunder(asked), tools: [refundTool(ran)], store });

  it("answers interrupted with the parked call, without waiting out the approval clock", async () => {
    const ran = { count: 0 };
    const asked = { reason: "" };
    const support = parking(memoryStore(), ran, asked);

    const startedAt = Date.now();
    const result = await support.chat("Refund invoice 7.", { as: "u_42" });
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe("interrupted");
    if (result.status !== "interrupted") return;
    expect(result.interruptions).toHaveLength(1);
    expect(result.interruptions[0]).toMatchObject({ type: "approval", toolCall: { tool: "refund" } });
    expect(result.text).toBe("I have asked for approval.");
    expect(ran.count).toBe(0);
    // The whole point of not blocking: the answer is the turn's own duration,
    // never the 90-second closed-tab bound.
    expect(elapsed).toBeLessThan(APPROVAL_WAIT_MS / 3);
  });

  it("tells a PRESENT user's agent that the ask is pending, not that nobody is around", async () => {
    const asked = { reason: "" };
    await parking(memoryStore(), { count: 0 }, asked).chat("Refund invoice 7.", { as: "u_42" });

    expect(asked.reason).not.toMatch(/nobody is here/);
    expect(asked.reason).toMatch(/needs approval/i);
  });

  it("still tells an AWAY run that nobody is there — because nobody is", async () => {
    // A READ tool, because §12 withholds a destructive one from an unattended
    // run outright: away parks every call it cannot trace to a grant, reads
    // included (guard.ts:1051), so this is what parking away looks like.
    const asked = { reason: "" };
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "lister",
        async *run(turn) {
          const result: ToolResult = await turn.tools.call("invoices_list", {});
          asked.reason = result.status === "denied" ? result.reason : result.status;
          yield { type: "text" as const, delta: "asked" };
        },
      }),
      tools: [tool({
        name: "invoices_list",
        description: "List invoices",
        risk: "read",
        inputSchema: { type: "object" },
        execute: () => ({ invoices: 2 }),
      })],
      store: memoryStore(),
    });

    await support.run("List the invoices.", { as: "u_42" });

    expect(asked.reason).toBe("This needs your approval, and nobody is here to give it.");
  });
});

describe("resume", () => {
  it("re-dispatches the approved call byte for byte and carries the turn on", async () => {
    const store = memoryStore();
    const ran = { count: 0 };
    const asked = { reason: "" };
    let turns = 0;
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "refunder",
        async *run(turn) {
          turns += 1;
          if (turns > 1) {
            yield { type: "text" as const, delta: "The refund went through." };
            return;
          }
          const result: ToolResult = await turn.tools.call("refund", {});
          asked.reason = result.status === "denied" ? result.reason : result.status;
          yield { type: "text" as const, delta: "I have asked for approval." };
        },
      }),
      tools: [refundTool(ran)],
      store,
    });

    const parked = support.chat("Refund invoice 7.", { as: "u_42" });
    const result = await parked;
    expect(result.status).toBe("interrupted");
    if (result.status !== "interrupted") return;

    const resumed = result.resume({ [result.interruptions[0]!.id]: "approve" });
    const answered = await resumed;

    // The exact call the person saw ran, once — a fresh call would have missed
    // the guard's approved replay and parked all over again.
    expect(ran.count).toBe(1);
    expect(answered).toMatchObject({ status: "ok", text: "The refund went through." });
    // One turn across the park: what was answered is what the answer is about.
    expect(resumed.turnId).toBe(parked.turnId);
    expect(resumed.threadId).toBe(parked.threadId);
    // And it is all one conversation, read back the way a reload reads it.
    expect((await transcriptOf(store, "u_42", parked.threadId)).map((message) => message.role))
      .toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("runs nothing for an interruption the caller turned down", async () => {
    const ran = { count: 0 };
    const asked = { reason: "" };
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "refunder",
        async *run(turn) {
          const result: ToolResult = await turn.tools.call("refund", {});
          asked.reason = result.status === "denied" ? result.reason : result.status;
          yield { type: "text" as const, delta: "asked" };
        },
      }),
      tools: [refundTool(ran)],
      store: memoryStore(),
    });

    const result = await support.chat("Refund invoice 7.", { as: "u_42" });
    if (result.status !== "interrupted") throw new Error(`expected interrupted, got ${result.status}`);
    await result.resume({ [result.interruptions[0]!.id]: "deny" });

    expect(ran.count).toBe(0);
  });
});
