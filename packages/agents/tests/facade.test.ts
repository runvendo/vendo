/**
 * `forUser`'s contract sentences, held against a real embedded store, a real
 * guard and real turns — only the thinker is scripted, because the thinker is
 * not what is under test (CLAUDE.md: test the SEAM).
 *
 * The headline is the split between what is BOUND and what is not: a profile
 * and a context are facts about a person and have to survive every call; a
 * request's headers are one request's authority and must not survive one. Both
 * halves are read back off the ctx a TOOL was actually handed and the brief the
 * HARNESS was actually given — never off the options object the test passed in,
 * which would only prove the test can spell.
 */
import type { Principal, RunContext } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import { describe, expect, it } from "vitest";
import { agent, agentComposition, type VendoAgent } from "../src/agent.js";
import { createTurns } from "../src/interruptions.js";
import { tool } from "../src/tools.js";
import type { TurnResult } from "../src/turn.js";

let stores = 0;
/** Deliberately UNMIGRATED: `ensureSchema` is the facade's own to pay, and one
 *  test below is exactly the host that reads before its first turn. */
const freshStore = (): VendoStore => createStore({ dataDir: `memory://agents-facade-${stores++}` });

const owner = (subject: string): Principal => ({ kind: "user", subject });

/** What ONE tool call was actually handed. */
interface Seen {
  subject: string;
  headers: Record<string, string> | undefined;
  context: Record<string, unknown> | undefined;
}

const lookTool = (seen: Seen[]) => tool({
  name: "look",
  description: "Look at the account",
  risk: "read",
  inputSchema: { type: "object" },
  execute: (_input, ctx: RunContext) => {
    seen.push({ subject: ctx.principal.subject, headers: ctx.requestHeaders, context: ctx.context });
    return { ok: true };
  },
});

/** Calls the tool (so the ctx is observed where a host's own code sees it) and
 *  keeps the brief it was handed (so the model-visible half is observed too). */
const looker = (briefs: string[]) => defineHarness({
  name: "looker",
  async *run(turn) {
    briefs.push(turn.system ?? "");
    await turn.tools.call("look", {});
    yield { type: "text" as const, delta: "Looked." };
  },
});

const speaker = () => defineHarness({
  name: "speaker",
  async *run() {
    yield { type: "text" as const, delta: "Done." };
  },
});

/** What the approved call was handed when it finally ran. */
interface Ran {
  count: number;
  context: Record<string, unknown> | undefined;
}

/** Ungraded/destructive is the one thing a guard with no rules at all still
 *  wants a person for — how a turn parks without a rule set standing in for the
 *  guard (interruptions.test.ts uses the same tool for the same reason). */
const refundTool = (ran: Ran) => tool({
  name: "refund",
  description: "Refund an invoice",
  risk: "destructive",
  inputSchema: { type: "object" },
  execute: (_input, ctx: RunContext) => {
    ran.count += 1;
    ran.context = ctx.context;
    return { refunded: true };
  },
});

const refunder = () => defineHarness({
  name: "refunder",
  async *run(turn) {
    const last = JSON.stringify(turn.messages.at(-1)?.parts ?? []);
    if (last.includes("[Resumed]")) {
      yield { type: "text" as const, delta: "The refund went through." };
      return;
    }
    await turn.tools.call("refund", { invoice: 7 });
    yield { type: "text" as const, delta: "I have asked for approval." };
  },
});

const interrupted = async (result: PromiseLike<TurnResult>): Promise<
  Extract<TurnResult, { status: "interrupted" }>
> => {
  const settled = await result;
  if (settled.status !== "interrupted") throw new Error(`expected interrupted, got ${settled.status}`);
  return settled;
};

describe("forUser binds who a person is — and never what one request may do", () => {
  it("carries profile and context into every call, and a request's headers into exactly one", async () => {
    const seen: Seen[] = [];
    const briefs: string[] = [];
    const support = agent({
      name: "support",
      harness: looker(briefs),
      tools: [lookTool(seen)],
      store: freshStore(),
    });
    const user = support.forUser("u_42", {
      profile: { name: "Dana", plan: "pro" },
      context: { tenantId: "t_1" },
    });

    await user.chat("one", { headers: { authorization: "Bearer one" } });
    await user.chat("two", { headers: { authorization: "Bearer two" } });
    await user.chat("three");

    // DURABLE: bound once, on every call, whatever the call brought.
    expect(seen.map((call) => call.subject)).toEqual(["u_42", "u_42", "u_42"]);
    expect(seen.map((call) => call.context)).toEqual([{ tenantId: "t_1" }, { tenantId: "t_1" }, { tenantId: "t_1" }]);
    expect(briefs).toHaveLength(3);
    for (const brief of briefs) {
      expect(brief).toContain("[User]");
      expect(brief).toContain("Dana");
      expect(brief).toContain("pro");
    }

    // REQUEST-LIFETIME: each call sees its own authority and only its own, and
    // a call that brings none is handed none — the facade kept nothing.
    expect(seen[0]?.headers).toEqual({ authorization: "Bearer one" });
    expect(seen[1]?.headers).toEqual({ authorization: "Bearer two" });
    expect(seen[2]?.headers).toBeUndefined();
  }, 30_000);
});

describe("a user's own conversations", () => {
  it("lists, reads and deletes theirs — and nobody else's", async () => {
    const support = agent({ name: "support", harness: speaker(), store: freshStore() });
    const dana = support.forUser("u_dana");
    const raj = support.forUser("u_raj");

    const hers = dana.chat("What is my balance?");
    expect(await hers).toMatchObject({ status: "ok" });
    expect(await raj.chat("And mine?")).toMatchObject({ status: "ok" });

    expect((await dana.threads.list()).map((thread) => thread.id)).toEqual([hers.threadId]);
    // The transcript, off the lazy accessor rather than the listing.
    const messages = JSON.stringify(await (await dana.threads.get(hers.threadId)).messages());
    expect(messages).toContain("What is my balance?");
    expect(messages).toContain("Done.");

    // Raj cannot see it, cannot read it, and cannot delete it.
    expect((await raj.threads.list()).map((thread) => thread.id)).not.toContain(hers.threadId);
    await expect(raj.threads.get(hers.threadId)).rejects.toMatchObject({ code: "not-found" });
    await raj.threads.delete(hers.threadId);
    expect((await dana.threads.list()).map((thread) => thread.id)).toEqual([hers.threadId]);

    // Her own delete does remove it, and then it is gone for her too.
    await dana.threads.delete(hers.threadId);
    expect(await dana.threads.list()).toEqual([]);
    await expect(dana.threads.get(hers.threadId)).rejects.toMatchObject({ code: "not-found" });
  }, 30_000);
});

describe("a user's own parked turns", () => {
  it("are the ones createTurns lists, and only this user can answer them", async () => {
    const ran: Ran = { count: 0, context: undefined };
    const support = agent({
      name: "support",
      harness: refunder(),
      tools: [refundTool(ran)],
      store: freshStore(),
    });
    const dana = support.forUser("u_dana");
    const raj = support.forUser("u_raj");

    const asked = await interrupted(dana.chat("Refund invoice 7."));
    const decisions = { [asked.interruptions[0]!.id]: "approve" as const };

    // The facade's face IS `createTurns(deps, subject)` — same rows, same shape.
    const direct = createTurns({ ...agentComposition(support)!, name: "support" }, "u_dana");
    const waiting = await dana.turns.list({ status: "interrupted" });
    expect(waiting).toEqual(await direct.list({ status: "interrupted" }));
    expect(waiting).toMatchObject([{ turnId: asked.turnId, threadId: asked.threadId }]);

    // Raj is not offered her turn and cannot answer it — a turn you do not own
    // reads back as absent, never as forbidden.
    expect(await raj.turns.list({ status: "interrupted" })).toEqual([]);
    await expect(raj.turns.resume(asked.turnId, decisions)).rejects.toMatchObject({ code: "not-found" });
    expect(ran.count).toBe(0);

    // Hers runs the exact call she was asked about, once.
    expect(await dana.turns.resume(asked.turnId, decisions)).toMatchObject({ status: "ok", turnId: asked.turnId });
    expect(ran.count).toBe(1);
  }, 30_000);

  it("run in the context the facade is bound to, unless the resuming call names its own", async () => {
    const ran: Ran = { count: 0, context: undefined };
    const support = agent({
      name: "support",
      harness: refunder(),
      tools: [refundTool(ran)],
      store: freshStore(),
    });
    const user = support.forUser("u_dana", { context: { tenantId: "t_1" } });

    // The bound context is the RESUMING caller's own standing context, alive at
    // the moment of the resume — so the call the person approved runs in the
    // tenant that parked it, not in none at all.
    const first = await interrupted(user.chat("Refund invoice 7."));
    await user.turns.resume(first.turnId, { [first.interruptions[0]!.id]: "approve" });
    expect(ran.context).toMatchObject({ tenantId: "t_1" });

    // And the resuming call still gets the last word.
    const second = await interrupted(user.chat("Refund invoice 8."));
    await user.turns.resume(
      second.turnId,
      { [second.interruptions[0]!.id]: "approve" },
      { context: { tenantId: "t_2" } },
    );
    expect(ran.context).toMatchObject({ tenantId: "t_2" });
  }, 30_000);
});

describe("what the agent remembers about a user", () => {
  it("is that user's alone, through every verb the person has", async () => {
    const store = freshStore();
    // The writes below are the ADAPTER's, not a turn's, so they pay for the
    // schema themselves; `memories.*` is the read side under test.
    await store.ensureSchema();
    const support = agent({ name: "support", harness: speaker(), store, memory: true });
    const memory = agentComposition(support)!.memory!;
    const hers = await memory.remember(owner("u_dana"), "Prefers window seats");
    await memory.remember(owner("u_raj"), "Prefers the aisle");

    const dana = support.forUser("u_dana");
    const raj = support.forUser("u_raj");
    expect((await dana.memories.list()).map((entry) => entry.text)).toEqual(["Prefers window seats"]);
    expect((await raj.memories.list()).map((entry) => entry.text)).toEqual(["Prefers the aisle"]);

    // Neither forgetting verb reaches across.
    await raj.memories.delete(hers.id);
    await raj.memories.clear();
    expect((await dana.memories.list()).map((entry) => entry.text)).toEqual(["Prefers window seats"]);

    await dana.memories.delete(hers.id);
    expect(await dana.memories.list()).toEqual([]);
  });

  it("says memory was never turned on rather than answering an empty list", async () => {
    const support = agent({ name: "support", harness: speaker(), store: freshStore() });
    const user = support.forUser("u_dana");
    await expect(user.memories.list()).rejects.toMatchObject({ code: "validation" });
    await expect(user.memories.clear()).rejects.toThrow(/memory: true/);
  });
});

describe("the first thing a host reads", () => {
  it("can be the facade itself, on a store no turn has migrated yet", async () => {
    const user = agent({ name: "support", harness: speaker(), store: freshStore() }).forUser("u_dana");
    expect(await user.threads.list()).toEqual([]);
    expect(await user.turns.list({ status: "interrupted" })).toEqual([]);
  });
});

describe("the paths forUser replaces", () => {
  it("still work — a deprecation is a path, not a removal", async () => {
    const support: VendoAgent = agent({ name: "support", harness: speaker(), store: freshStore() });

    // `run({ as })`: the run is still that subject's, which is provable from the
    // conversation it left behind — only its owner can see it.
    const run = support.run("check the account", { as: "u_42" });
    expect(await run).toMatchObject({ status: "ok" });
    expect((await support.forUser("u_42").threads.list()).map((thread) => thread.id)).toEqual([run.threadId]);

    // `session()`: still opens a conversation for that subject.
    const session = await support.session("u_42");
    expect(session.threadId).toMatch(/^thr_/);
  }, 30_000);
});
