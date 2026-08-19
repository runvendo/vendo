/**
 * Turns that are waiting on a person — found and answered from somewhere else.
 *
 * Real embedded store, real guard, real `createHarnessRuntime`; only the
 * thinker is scripted, because the thinker is not what is under test
 * (CLAUDE.md: test the SEAM). The headline case is a RESTART, and it is an
 * honest one: the parking composition's store handle is CLOSED and a second
 * composition is built over the same data directory, sharing no in-memory
 * object with the first — no agent, no guard, no harness, no tool closure. If
 * the park were living in a promise rather than in the store, nothing below
 * would find it.
 */
import { createGuard } from "@vendoai/guard";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, threadMessageStore, type VendoStore } from "@vendoai/store";
import { VendoError, type RunContext, type ToolResult } from "@vendoai/core";
import type { UIMessage } from "ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agent, agentComposition, type VendoAgent } from "../src/agent.js";
import { createTurns, PARKED_TURN_TTL_MS, type Turns } from "../src/interruptions.js";
import { tool } from "../src/tools.js";
import type { TurnResult } from "../src/turn.js";

let stores = 0;
const memoryStore = (): VendoStore => createStore({ dataDir: `memory://agents-interruptions-${stores++}` });

const owner = (subject: string) => ({ kind: "user" as const, subject });

const temporary: Array<{ dir: string; store: VendoStore }> = [];
afterEach(async () => {
  for (const { dir, store } of temporary.splice(0)) {
    await store.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

/** What one call was handed when it finally ran: the authority of the call that
 *  answered it, never the authority of the request that asked. */
interface Ran {
  count: number;
  headers?: Record<string, string>;
  context?: Record<string, unknown>;
}

/** Ungraded/destructive is the one thing a guard with no rules at all still
 *  wants a person for, so this is how a turn parks without a rule set standing
 *  in for the guard (turn.test.ts uses the same tool for the same reason). */
const refundTool = (ran: Ran) => tool({
  name: "refund",
  description: "Refund an invoice",
  risk: "destructive",
  inputSchema: { type: "object" },
  execute: (_input, ctx: RunContext) => {
    ran.count += 1;
    ran.headers = ctx.requestHeaders;
    ran.context = ctx.context;
    return { refunded: true };
  },
});

/**
 * A thinker that decides from the TRANSCRIPT, because that is all a restarted
 * process has: it asks for the refund when the conversation asks for one,
 * reports when it reads that the approvals were answered, and otherwise just
 * talks. A counter would have been a lie here — the resuming composition's
 * harness is a fresh object and its own counter starts at zero.
 */
const refunder = (calls = 1) => defineHarness({
  name: "refunder",
  async *run(turn) {
    const last = JSON.stringify(turn.messages.at(-1)?.parts ?? []);
    if (last.includes("[Resumed]")) {
      yield { type: "text" as const, delta: "The refund went through." };
      return;
    }
    if (!last.includes("efund")) {
      yield { type: "text" as const, delta: "Your balance is fine." };
      return;
    }
    for (let index = 0; index < calls; index += 1) {
      const result: ToolResult = await turn.tools.call("refund", { invoice: index });
      if (result.status === "ok") throw new Error("the guard was supposed to park this");
    }
    yield { type: "text" as const, delta: "I have asked for approval." };
  },
});

const parking = (store: VendoStore, ran: Ran, calls = 1): VendoAgent =>
  agent({ name: "support", harness: refunder(calls), tools: [refundTool(ran)], store });

/** The `turns` face PR4 hangs off a user, over a real composition. */
const turnsOf = (built: VendoAgent, subject: string): Turns =>
  createTurns({ ...agentComposition(built)!, name: "support" }, subject);

const interrupted = async (result: PromiseLike<TurnResult>): Promise<
  Extract<TurnResult, { status: "interrupted" }>
> => {
  const settled = await result;
  if (settled.status !== "interrupted") throw new Error(`expected interrupted, got ${settled.status}`);
  return settled;
};

const transcriptOf = (store: VendoStore, subject: string, threadId: string): Promise<UIMessage[]> =>
  threadMessageStore<UIMessage>(store).list(owner(subject), threadId as never);

describe("an interrupted turn outlives the process that parked it", () => {
  it("is listed and resumed by a composition that shares nothing with the one that parked it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vendo-agents-interruptions-"));
    const parked = { count: 0 };
    const first = createStore({ dataDir: dir });
    const asked = await interrupted(parking(first, parked).chat("Refund invoice 7.", { as: "u_42" }));

    // THE RESTART. Everything the first composition held goes away with it.
    await first.close();

    const resumedRuns = { count: 0 };
    const second = createStore({ dataDir: dir });
    temporary.push({ dir, store: second });
    const support = parking(second, resumedRuns);
    const turns = turnsOf(support, "u_42");

    const waiting = await turns.list({ status: "interrupted" });
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      turnId: asked.turnId,
      threadId: asked.threadId,
      interruptions: [{ id: asked.interruptions[0]?.id, type: "approval", toolCall: { tool: "refund" } }],
    });

    const answered = await turns.resume(asked.turnId, { [asked.interruptions[0]!.id]: "approve" });

    // The exact call the person saw ran, in the NEW process, once — and never
    // in the old one, which only ever asked.
    expect(parked.count).toBe(0);
    expect(resumedRuns.count).toBe(1);
    // One turn across the park, whatever restarted in between.
    expect(answered).toMatchObject({
      status: "ok",
      text: "The refund went through.",
      turnId: asked.turnId,
      threadId: asked.threadId,
    });
    // And it is all one conversation, read back the way a reload reads it.
    expect((await transcriptOf(second, "u_42", asked.threadId)).map((message) => message.role))
      .toEqual(["user", "assistant", "user", "assistant"]);

    // Answered once is answered: nothing is left waiting, and a client that
    // retries the resume is told so rather than running the refund again.
    expect(await turns.list({ status: "interrupted" })).toEqual([]);
    const again = await turns.resume(asked.turnId, { [asked.interruptions[0]!.id]: "approve" })
      .catch((error: unknown) => error);
    expect(again).toBeInstanceOf(VendoError);
    expect((again as VendoError).code).toBe("conflict");
    expect(resumedRuns.count).toBe(1);
  }, 60_000);
});

describe("an approved call runs once, however many callers answer", () => {
  it("survives two processes resuming the same turn at the same instant", async () => {
    const ran = { count: 0 };
    const support = parking(memoryStore(), ran);
    const turns = turnsOf(support, "u_42");
    const asked = await interrupted(support.chat("Refund invoice 7.", { as: "u_42" }));
    const decisions = { [asked.interruptions[0]!.id]: "approve" as const };

    const answers = await Promise.all([
      turns.resume(asked.turnId, decisions).catch((error: unknown) => error),
      turns.resume(asked.turnId, decisions).catch((error: unknown) => error),
    ]);

    // The refund happened once. Not because this layer sequenced anything —
    // both callers read the same pending ask — but because deciding an
    // approval is a one-time transition in the guard, and the call it
    // authorizes is replayable exactly once.
    expect(ran.count).toBe(1);
    expect(answers.filter((answer) => (answer as { status?: string }).status === "ok")).toHaveLength(1);
  }, 30_000);
});

describe("every interruption is answered, or none is", () => {
  it("refuses a partial decision map by name, and leaves the turn exactly as it was", async () => {
    const ran = { count: 0 };
    const support = parking(memoryStore(), ran, 2);
    const turns = turnsOf(support, "u_42");
    const asked = await interrupted(support.chat("Refund invoice 7 and invoice 8.", { as: "u_42" }));
    expect(asked.interruptions).toHaveLength(2);

    const refused = await turns.resume(asked.turnId, { [asked.interruptions[0]!.id]: "approve" })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(VendoError);
    expect((refused as VendoError).code).toBe("validation");
    // Named, because "a decision is missing" is unanswerable from a client
    // holding several.
    expect((refused as VendoError).message).toContain(asked.interruptions[1]!.id);
    expect((refused as VendoError).message).not.toContain(asked.interruptions[0]!.id);

    // Nothing ran, and nothing was decided on the way out: the turn is still
    // there to answer properly.
    expect(ran.count).toBe(0);
    expect((await turns.list({ status: "interrupted" }))[0]?.interruptions).toHaveLength(2);
  }, 30_000);
});

describe("authority comes from the call that resumes", () => {
  const parkWith = async (store: VendoStore, ran: Ran) => {
    const support = parking(store, ran);
    const asked = await interrupted(support.chat("Refund invoice 7.", {
      as: "u_42",
      headers: { authorization: "Bearer parked" },
      context: { tenant: "parked" },
    }));
    return { turns: turnsOf(support, "u_42"), asked };
  };

  it("runs the approved call with the resuming call's headers and context, never the parked ones", async () => {
    const ran: Ran = { count: 0 };
    const { turns, asked } = await parkWith(memoryStore(), ran);

    await turns.resume(asked.turnId, { [asked.interruptions[0]!.id]: "approve" }, {
      headers: { authorization: "Bearer fresh" },
      context: { tenant: "fresh" },
    });

    expect(ran.count).toBe(1);
    expect(ran.headers).toEqual({ authorization: "Bearer fresh" });
    expect(ran.context).toEqual({ tenant: "fresh" });
  }, 30_000);

  it("carries no authority at all when the resuming call brings none", async () => {
    const ran: Ran = { count: 0 };
    const { turns, asked } = await parkWith(memoryStore(), ran);

    await turns.resume(asked.turnId, { [asked.interruptions[0]!.id]: "approve" });

    // The parked request's headers were request-lifetime and that request is
    // over — a resume that inherited them would be a token outliving its call.
    expect(ran.count).toBe(1);
    expect(ran.headers).toBeUndefined();
    expect(ran.context).toBeUndefined();
  }, 30_000);
});

describe("a turn you do not own", () => {
  it("reads back as absent, and cannot be answered on the owner's behalf", async () => {
    const ran = { count: 0 };
    const support = parking(memoryStore(), ran);
    const asked = await interrupted(support.chat("Refund invoice 7.", { as: "u_42" }));

    const stranger = turnsOf(support, "u_99");
    expect(await stranger.list({ status: "interrupted" })).toEqual([]);
    const refused = await stranger.resume(asked.turnId, { [asked.interruptions[0]!.id]: "approve" })
      .catch((error: unknown) => error);

    // The ownership law: a thing you do not own is missing, never forbidden —
    // "you may not answer this" would confirm it exists.
    expect(refused).toBeInstanceOf(VendoError);
    expect((refused as VendoError).code).toBe("not-found");
    expect(ran.count).toBe(0);
    // And the owner's turn is untouched by the attempt.
    expect(await turnsOf(support, "u_42").list({ status: "interrupted" })).toHaveLength(1);
  }, 30_000);
});

describe("a parked turn waits a week, and says so when the week is up", () => {
  it("gives an agent's own guard seven days, and leaves a passed-in guard exactly as it came", () => {
    const mine = agent({ name: "support", harness: refunder(), store: memoryStore() });
    expect(agentComposition(mine)?.guard.approvals.parkedCallTtlMs).toBe(PARKED_TURN_TTL_MS);
    expect(PARKED_TURN_TTL_MS).toBe(7 * 24 * 60 * 60_000);

    const host = agent({
      name: "support",
      harness: refunder(),
      store: memoryStore(),
      guard: { approvals: { parkedCallTtlMs: 60_000 } },
    });
    expect(agentComposition(host)?.guard.approvals.parkedCallTtlMs).toBe(60_000);

    // ADAPTER RULE: a built instance is this deployment's choke point, TTL
    // included — the guard's own hour, not ours.
    const store = memoryStore();
    const instance = agent({ name: "support", harness: refunder(), store, guard: createGuard({ store }) });
    expect(agentComposition(instance)?.guard.approvals.parkedCallTtlMs).toBe(60 * 60_000);
  });

  it("names the expiry instead of losing the turn quietly", async () => {
    const ran = { count: 0 };
    const support = agent({
      name: "support",
      harness: refunder(),
      tools: [refundTool(ran)],
      store: memoryStore(),
      // One millisecond: the same clock the seven days ride, wound forward.
      guard: { approvals: { parkedCallTtlMs: 1 } },
    });
    const turns = turnsOf(support, "u_42");
    const asked = await interrupted(support.chat("Refund invoice 7.", { as: "u_42" }));

    // A turn nobody can act on is not on the list of turns to act on.
    await expect.poll(async () => turns.list({ status: "interrupted" }), { timeout: 20_000, interval: 25 })
      .toEqual([]);
    const refused = await turns.resume(asked.turnId, { [asked.interruptions[0]!.id]: "approve" })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(VendoError);
    expect((refused as VendoError).code).toBe("conflict");
    expect((refused as VendoError).message).toMatch(/expired/);
    // What happened, and how it ends.
    expect((refused as VendoError).message).toMatch(/send the request again/);
    expect(ran.count).toBe(0);
  }, 30_000);
});

describe("a message that arrives instead of an answer", () => {
  /**
   * PINNED, not chosen here.
   *
   * A user who types again rather than answering does NOT lose the ask on this
   * lane, and the reason is structural: every turn here runs
   * `interactive: false`, so a parked call is refused on the spot and leaves no
   * `approval-requested` part behind (turn-tools.ts, the `!options.interactive`
   * branch — the card "stands", which is exactly what `standing: true` means to
   * the waiter). The next turn's abandonment sweep only flips parts in that
   * state (`abandonPendingApprovals`, transcript-rules.ts, read by
   * `abandonStaleApprovals`, runtime.ts), so it finds nothing of ours. The
   * streaming lane (`session()`/`respond()`, `interactive: true`) is where
   * approval parts are written and where the next turn withdraws them.
   *
   * The behaviour is not this slice's to change. What IS this slice's is that
   * `list` and `resume` agree with the guard about it, whichever way it goes:
   * a turn the list offers can still be answered.
   */
  it("leaves the interruption standing, and the turn is still answerable after it", async () => {
    const ran = { count: 0 };
    const support = parking(memoryStore(), ran);
    const turns = turnsOf(support, "u_42");
    const asked = await interrupted(support.chat("Refund invoice 7.", { as: "u_42" }));
    expect(await turns.list({ status: "interrupted" })).toHaveLength(1);

    const moved = await support.chat("Actually, what is my balance?", {
      as: "u_42",
      threadId: asked.threadId,
    });
    expect(moved).toMatchObject({ status: "ok", text: "Your balance is fine." });

    expect(await turns.list({ status: "interrupted" })).toMatchObject([{ turnId: asked.turnId }]);
    const answered = await turns.resume(asked.turnId, { [asked.interruptions[0]!.id]: "approve" });
    expect(answered).toMatchObject({ status: "ok", turnId: asked.turnId });
    expect(ran.count).toBe(1);
    expect(await turns.list({ status: "interrupted" })).toEqual([]);
  }, 30_000);
});
