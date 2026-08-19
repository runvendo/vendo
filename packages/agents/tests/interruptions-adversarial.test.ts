/**
 * ADVERSARIAL probes against `createTurns` (src/interruptions.ts).
 *
 * Real store, real guard, real registry, real turn — the only scripted thing is
 * the thinker, exactly as interruptions.test.ts has it. Every assertion below
 * states the behaviour the slice CLAIMS; a red one is a defect.
 */
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import {
  VendoError,
  type Decisions,
  type RunContext,
  type ToolCall,
  type ToolResult,
} from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { agent, agentComposition, type VendoAgent } from "../src/agent.js";
import { createTurns, type Turns } from "../src/interruptions.js";
import { tool } from "../src/tools.js";
import type { TurnResult } from "../src/turn.js";

let stores = 0;
const memoryStore = (): VendoStore => createStore({ dataDir: `memory://agents-adversarial-${stores++}` });

const open: VendoStore[] = [];
const keep = (store: VendoStore): VendoStore => {
  open.push(store);
  return store;
};
afterEach(async () => {
  for (const store of open.splice(0)) await store.close().catch(() => {});
});

interface Ran {
  count: number;
  headers?: Record<string, string>;
  context?: Record<string, unknown>;
}

/** Byte-identical descriptor wherever it is mounted — the point of several
 *  probes below is that `descriptorHash` cannot tell two mountings apart. */
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

const parking = (store: VendoStore, ran: Ran, calls = 1, name = "support"): VendoAgent =>
  agent({ name, harness: refunder(calls), tools: [refundTool(ran)], store });

const turnsOf = (built: VendoAgent, subject: string): Turns =>
  createTurns({ ...agentComposition(built)!, name: "support" }, subject);

const interrupted = async (result: PromiseLike<TurnResult>): Promise<
  Extract<TurnResult, { status: "interrupted" }>
> => {
  const settled = await result;
  if (settled.status !== "interrupted") throw new Error(`expected interrupted, got ${settled.status}`);
  return settled;
};

const errorOf = async (promise: PromiseLike<unknown>): Promise<VendoError> => {
  const settled = await Promise.resolve(promise).then(
    (value) => value,
    (error: unknown) => error,
  );
  if (!(settled instanceof VendoError)) {
    throw new Error(`expected a VendoError, got ${JSON.stringify(settled)}`);
  }
  return settled;
};

/** The approvals collection, read and written the way any other build of this
 *  repo writes it — used to age a row, or to malform the one field the TTL is
 *  computed from. */
const approvalRow = async (store: VendoStore, id: string): Promise<{
  data: { request: { createdAt: string } };
  refs?: Record<string, string>;
}> => {
  const record = await store.records("vendo_approvals").get(id);
  if (record === null) throw new Error(`no approval row ${id}`);
  return record as never;
};

const rewriteCreatedAt = async (store: VendoStore, id: string, createdAt: string): Promise<void> => {
  const record = await approvalRow(store, id);
  record.data.request.createdAt = createdAt;
  await store.records("vendo_approvals").put({
    id,
    data: record.data as never,
    ...(record.refs === undefined ? {} : { refs: record.refs }),
  });
};

// ---------------------------------------------------------------------------
// 1. EXACTLY ONCE
// ---------------------------------------------------------------------------

describe("exactly once, pushed harder", () => {
  it("runs the approved call once across eight simultaneous resumes", async () => {
    const ran = { count: 0 };
    const support = parking(keep(memoryStore()), ran);
    const turns = turnsOf(support, "u_42");
    const asked = await interrupted(support.chat("Refund invoice 7.", { as: "u_42" }));
    const decisions: Decisions = { [asked.interruptions[0]!.id]: "approve" };

    const answers = await Promise.all(
      Array.from({ length: 8 }, () =>
        turns.resume(asked.turnId, decisions).catch((error: unknown) => error)),
    );

    expect(ran.count).toBe(1);
    expect(answers.filter((answer) => (answer as { status?: string }).status === "ok")).toHaveLength(1);
    // And nothing is left for a ninth caller to answer: a resume that lost the
    // race must not leave a fresh ask standing for the same call.
    expect(await turns.list({ status: "interrupted" })).toEqual([]);
  }, 60_000);

  it("runs it once when two independent compositions over one store resume at the same instant", async () => {
    // Two `agent()` calls = two guards, two registries, two bound tool sets.
    // Nothing in memory is shared; the only common ground is the store, which
    // is exactly what two processes share.
    const store = keep(memoryStore());
    const parkedRan = { count: 0 };
    const otherRan = { count: 0 };
    const first = parking(store, parkedRan);
    const second = parking(store, otherRan);
    const asked = await interrupted(first.chat("Refund invoice 7.", { as: "u_42" }));
    const decisions: Decisions = { [asked.interruptions[0]!.id]: "approve" };

    const answers = await Promise.all([
      turnsOf(first, "u_42").resume(asked.turnId, decisions).catch((error: unknown) => error),
      turnsOf(second, "u_42").resume(asked.turnId, decisions).catch((error: unknown) => error),
    ]);

    expect(parkedRan.count + otherRan.count).toBe(1);
    expect(answers.filter((answer) => (answer as { status?: string }).status === "ok")).toHaveLength(1);
    expect(await turnsOf(first, "u_42").list({ status: "interrupted" })).toEqual([]);
  }, 60_000);

  it("never runs the second of two approved calls twice when resumes race", async () => {
    const ran = { count: 0 };
    const support = parking(keep(memoryStore()), ran, 2);
    const turns = turnsOf(support, "u_42");
    const asked = await interrupted(support.chat("Refund invoice 7 and invoice 8.", { as: "u_42" }));
    expect(asked.interruptions).toHaveLength(2);
    const decisions: Decisions = {
      [asked.interruptions[0]!.id]: "approve",
      [asked.interruptions[1]!.id]: "approve",
    };

    await Promise.all([
      turns.resume(asked.turnId, decisions).catch((error: unknown) => error),
      turns.resume(asked.turnId, decisions).catch((error: unknown) => error),
      turns.resume(asked.turnId, decisions).catch((error: unknown) => error),
    ]);

    expect(ran.count).toBe(2);
    expect(await turns.list({ status: "interrupted" })).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. OWNERSHIP, AND THE LANE FILTER
// ---------------------------------------------------------------------------

describe("a subject only ever sees its own", () => {
  const hostile = ["u_4", "U_42", "u_42 ", "u:42", "u/42", "u_42\nu_99", ""];

  it("hides an interrupted turn from every neighbouring spelling of its owner", async () => {
    const ran = { count: 0 };
    const support = parking(keep(memoryStore()), ran);
    const asked = await interrupted(support.chat("Refund invoice 7.", { as: "u_42" }));

    for (const subject of hostile) {
      const stranger = turnsOf(support, subject);
      expect(await stranger.list({ status: "interrupted" })).toEqual([]);
      const refused = await errorOf(
        stranger.resume(asked.turnId, { [asked.interruptions[0]!.id]: "approve" }),
      );
      expect(refused.code).toBe("not-found");
      expect(refused.message).not.toMatch(/forbidden|not allowed|permission/i);
    }
    expect(ran.count).toBe(0);
    expect(await turnsOf(support, "u_42").list({ status: "interrupted" })).toHaveLength(1);
  }, 60_000);
});

describe("a turn that belongs to another agent", () => {
  it("is not offered by an agent that did not park it", async () => {
    const store = keep(memoryStore());
    const opsRan = { count: 0 };
    const supportRan = { count: 0 };
    const ops = parking(store, opsRan, 1, "ops");
    const support = parking(store, supportRan, 1, "support");
    // Awaited for effect: this is what parks `ops`' ask, which is the thing
    // `support` must not be able to see below.
    await interrupted(ops.chat("Refund invoice 7.", { as: "u_42" }));

    // `support` never asked this person for anything.
    expect(await turnsOf(support, "u_42").list({ status: "interrupted" })).toEqual([]);
    expect(await turnsOf(ops, "u_42").list({ status: "interrupted" })).toHaveLength(1);
  }, 60_000);

  it("cannot be answered through a different agent's registry", async () => {
    const store = keep(memoryStore());
    const opsRan = { count: 0 };
    const supportRan = { count: 0 };
    const ops = parking(store, opsRan, 1, "ops");
    const support = parking(store, supportRan, 1, "support");
    const asked = await interrupted(ops.chat("Refund invoice 7.", { as: "u_42" }));

    const settled = await turnsOf(support, "u_42")
      .resume(asked.turnId, { [asked.interruptions[0]!.id]: "approve" })
      .then((value: unknown) => value, (error: unknown) => error);

    // Soft, so one run shows the whole shape of the damage.
    expect.soft(settled).toBeInstanceOf(VendoError);
    // The yes the person gave `ops` must never spend itself inside `support` —
    // the two registries mount byte-identical descriptors, and `descriptorHash`
    // covers name/description/inputSchema/risk, so the replay match cannot tell
    // one mounting's `execute` from the other's.
    expect.soft(supportRan.count).toBe(0);
    expect.soft(opsRan.count).toBe(0);
    // And the ask `ops` parked is still there to answer.
    expect.soft(await turnsOf(ops, "u_42").list({ status: "interrupted" })).toHaveLength(1);
  }, 60_000);

  it("does not burn the person's yes on an agent that has no such tool", async () => {
    const store = keep(memoryStore());
    const opsRan = { count: 0 };
    const ops = parking(store, opsRan, 1, "ops");
    // A second agent over the same store with a DIFFERENT tool surface.
    const bare = agent({ name: "bare", harness: refunder(), store });
    const asked = await interrupted(ops.chat("Refund invoice 7.", { as: "u_42" }));

    await turnsOf(bare, "u_42").resume(asked.turnId, { [asked.interruptions[0]!.id]: "approve" })
      .catch(() => undefined);

    // Whatever the answer was, the ask must still be answerable where it lives:
    // approving into a registry that cannot dispatch the call is a yes spent on
    // nothing.
    expect(opsRan.count).toBe(0);
    expect(await turnsOf(ops, "u_42").list({ status: "interrupted" })).toHaveLength(1);
  }, 60_000);
});

describe("the lane filter", () => {
  /** Park a call straight through the guard-bound registry, on any ctx at all —
   *  the same write path a turn uses, without a turn. */
  const parkOn = async (built: VendoAgent, ctx: RunContext, id: string): Promise<void> => {
    const composition = agentComposition(built)!;
    await composition.store.ensureSchema();
    const call: ToolCall = { id, tool: "refund", args: { invoice: 1 } };
    await composition.tools.execute(call, ctx);
  };

  const base = (subject: string): RunContext => ({
    principal: { kind: "user", subject },
    venue: "chat",
    presence: "present",
    sessionId: "thr_lane",
  });

  it("keeps an app action, an automation firing and a turn-less check out of the list", async () => {
    const ran = { count: 0 };
    const support = parking(keep(memoryStore()), ran);
    const turnId = "trn_00000000000000000000000000000001";

    await parkOn(support, { ...base("u_42"), appId: "app_x" as never, turnId: turnId as never }, "c_app");
    await parkOn(support, {
      ...base("u_42"),
      venue: "automation",
      trigger: { automationId: "atm_1", runId: "run_1", kind: "schedule" } as never,
      turnId: turnId as never,
    }, "c_auto");
    // A row from before this slice existed: no turnId at all.
    await parkOn(support, base("u_42"), "c_old");

    const turns = turnsOf(support, "u_42");
    expect(await turns.list({ status: "interrupted" })).toEqual([]);
    expect(ran.count).toBe(0);
  }, 60_000);

  it("does not resume an app-lane park through the chat lane", async () => {
    const ran = { count: 0 };
    const support = parking(keep(memoryStore()), ran);
    const turnId = "trn_00000000000000000000000000000002";
    await parkOn(support, { ...base("u_42"), appId: "app_x" as never, turnId: turnId as never }, "c_app2");

    const refused = await errorOf(turnsOf(support, "u_42").resume(turnId, { c_app2: "approve" }));
    expect(refused.code).toBe("not-found");
    expect(ran.count).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. THE TTL
// ---------------------------------------------------------------------------

describe("the seven days", () => {
  const shortLived = (store: VendoStore, ran: Ran, ttlMs: number): VendoAgent =>
    agent({
      name: "support",
      harness: refunder(),
      tools: [refundTool(ran)],
      store,
      guard: { approvals: { parkedCallTtlMs: ttlMs } },
    });

  it("refuses an expired ask on EVERY face, not only on turns.resume", async () => {
    const ran = { count: 0 };
    const support = shortLived(keep(memoryStore()), ran, 1);
    const turns = turnsOf(support, "u_42");
    const asked = await interrupted(support.chat("Refund invoice 7.", { as: "u_42" }));

    await expect.poll(async () => turns.list({ status: "interrupted" }), { timeout: 20_000, interval: 25 })
      .toEqual([]);
    // The ask is expired — `turns.resume` says so. The caller still holding the
    // result is the SAME ask, on the same guard, past the same deadline.
    await Promise.resolve(asked.resume({ [asked.interruptions[0]!.id]: "approve" }))
      .catch(() => undefined);

    expect(ran.count).toBe(0);
  }, 60_000);

  it("is expired exactly at createdAt + ttl, and alive one second inside it", async () => {
    const store = keep(memoryStore());
    const ran = { count: 0 };
    const support = shortLived(store, ran, 60_000);
    const turns = turnsOf(support, "u_42");
    const asked = await interrupted(support.chat("Refund invoice 7.", { as: "u_42" }));
    const id = asked.interruptions[0]!.id;

    await rewriteCreatedAt(store, id, new Date(Date.now() - 59_000).toISOString());
    expect(await turns.list({ status: "interrupted" })).toHaveLength(1);

    await rewriteCreatedAt(store, id, new Date(Date.now() - 60_000).toISOString());
    expect(await turns.list({ status: "interrupted" })).toEqual([]);
    const refused = await errorOf(turns.resume(asked.turnId, { [id]: "approve" }));
    expect(refused.code).toBe("conflict");
    expect(ran.count).toBe(0);
  }, 60_000);

  it("answers the live ask of a turn whose other ask expired", async () => {
    const store = keep(memoryStore());
    const ran = { count: 0 };
    const support = agent({
      name: "support",
      harness: refunder(2),
      tools: [refundTool(ran)],
      store,
      guard: { approvals: { parkedCallTtlMs: 60_000 } },
    });
    const turns = turnsOf(support, "u_42");
    const asked = await interrupted(support.chat("Refund invoice 7 and invoice 8.", { as: "u_42" }));
    expect(asked.interruptions).toHaveLength(2);
    const stale = asked.interruptions[0]!.id;
    const live = asked.interruptions[1]!.id;

    // Two asks parked minutes apart; a week later only the elder is past its
    // deadline. Nothing sweeps, so the dead row is still on the pending feed.
    await rewriteCreatedAt(store, stale, new Date(Date.now() - 60_000).toISOString());

    // `list` offers this turn with ONE ask on it, so that ask has to be
    // answerable and answering exactly it has to be enough. Demanding the
    // expired one too made a listed turn unanswerable both ways — and there is
    // no sweeper to clear it afterwards.
    const listed = await turns.list({ status: "interrupted" });
    expect(listed[0]!.interruptions.map((one) => one.id)).toEqual([live]);

    const answered = await turns.resume(asked.turnId, { [live]: "approve" });
    expect(answered).toMatchObject({ status: "ok", turnId: asked.turnId });
    expect(ran.count).toBe(1);
  }, 60_000);

  it("cannot be handed an unreadable createdAt in the first place", async () => {
    const store = keep(memoryStore());
    const ran = { count: 0 };
    const support = shortLived(store, ran, 60_000);
    const asked = await interrupted(support.chat("Refund invoice 7.", { as: "u_42" }));

    // `expired()` computes `Date.parse(createdAt) + ttl <= at`, and NaN loses
    // every comparison — an unparseable timestamp would read as never expiring,
    // which is fail-OPEN on the only thing standing between a week-old yes and
    // a live refund. The branch is unreachable: the store parses an approval row
    // on the way in, so no writer can put one there.
    await expect(rewriteCreatedAt(store, asked.interruptions[0]!.id, "whenever"))
      .rejects.toThrow(/datetime/i);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. THE DECISION MAP
// ---------------------------------------------------------------------------

describe("the decision map", () => {
  const parkOne = async (ran: Ran) => {
    const support = parking(keep(memoryStore()), ran);
    const asked = await interrupted(support.chat("Refund invoice 7.", { as: "u_42" }));
    return { turns: turnsOf(support, "u_42"), asked, id: asked.interruptions[0]!.id };
  };

  it("names every parked id when the map is empty", async () => {
    const ran = { count: 0 };
    const { turns, asked, id } = await parkOne(ran);
    const refused = await errorOf(turns.resume(asked.turnId, {}));
    expect(refused.code).toBe("validation");
    expect(refused.message).toContain(id);
    expect(await turns.list({ status: "interrupted" })).toHaveLength(1);
  }, 60_000);

  it("names the parked id when the map holds only ids this turn never parked", async () => {
    const ran = { count: 0 };
    const { turns, asked, id } = await parkOne(ran);
    const refused = await errorOf(turns.resume(asked.turnId, { apr_nope: "approve", other: "deny" }));
    expect(refused.code).toBe("validation");
    expect(refused.message).toContain(id);
    expect(ran.count).toBe(0);
  }, 60_000);

  it("survives a prototype-shaped key without crashing or answering anything", async () => {
    const ran = { count: 0 };
    const { turns, asked, id } = await parkOne(ran);
    const hostile = JSON.parse('{"__proto__":"approve","constructor":"approve"}') as Decisions;
    const refused = await errorOf(turns.resume(asked.turnId, hostile));
    expect(refused.code).toBe("validation");
    expect(refused.message).toContain(id);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(ran.count).toBe(0);
  }, 60_000);

  it("refuses an input answer given for an approval instead of silently denying it", async () => {
    const ran = { count: 0 };
    const { turns, asked, id } = await parkOne(ran);

    // `{ answers }` is a well-typed `Decision` — the compiler accepts it for an
    // approval interruption. It is not a verdict, so it cannot be one.
    // `settleInterruptions` reads `decision === "approve"` and calls everything
    // else a no (turn.ts:415), so this lands as a DENIAL nobody made.
    const settled = await turns.resume(asked.turnId, { [id]: { answers: { q: "yes" } } })
      .then((value: unknown) => value, (error: unknown) => error);

    expect.soft(settled).toBeInstanceOf(VendoError);
    // The one-shot ask must survive a malformed answer: this person never said
    // no, and after this they can never say yes.
    expect.soft(await turns.list({ status: "interrupted" })).toHaveLength(1);
    expect.soft(ran.count).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. TWO TURNS ON ONE THREAD
// ---------------------------------------------------------------------------

describe("two turns running at once on one thread", () => {
  /** Both turns reach the tool call — and are therefore both subscribed to the
   *  guard — before either parks. The overlap is the point of the probe, so it
   *  is arranged rather than left to the machine's timing. */
  const barrier = (count: number): (() => Promise<void>) => {
    let arrived = 0;
    let release!: () => void;
    const all = new Promise<void>((resolve) => {
      release = resolve;
    });
    return async () => {
      arrived += 1;
      if (arrived === count) release();
      await all;
    };
  };

  const paired = (arrive: () => Promise<void>) => {
    let invoice = 0;
    return defineHarness({
      name: "paired",
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
        await arrive();
        // Its own invoice, so neither turn's card can be mistaken for the
        // other's by anything but the id it was collected under.
        invoice += 1;
        await turn.tools.call("refund", { invoice });
        yield { type: "text" as const, delta: "I have asked for approval." };
      },
    });
  };

  it("keeps each turn's approval to itself, and refuses to spend the sibling's yes", async () => {
    const ran = { count: 0 };
    const support = agent({
      name: "support",
      harness: paired(barrier(2)),
      tools: [refundTool(ran)],
      store: keep(memoryStore()),
    });
    // One thread, opened by a turn that asks for nothing.
    const opened = await support.chat("What is my balance?", { as: "u_42" });
    const { threadId } = opened;

    const [seven, eight] = await Promise.all([
      interrupted(support.chat("Refund invoice 7.", { as: "u_42", threadId })),
      interrupted(support.chat("Refund invoice 8.", { as: "u_42", threadId })),
    ]);

    // Nothing serialises a thread, and the guard's own run key IS the thread —
    // so each turn used to collect both cards and report the other's ask as its
    // own.
    expect(seven.interruptions).toHaveLength(1);
    expect(eight.interruptions).toHaveLength(1);
    expect(seven.interruptions[0]!.id).not.toBe(eight.interruptions[0]!.id);

    // And a decision named on the wrong turn decides nothing: one ask, answered
    // once, by the turn that asked it.
    await Promise.resolve(seven.resume({ [eight.interruptions[0]!.id]: "approve" }))
      .catch(() => undefined);
    expect(ran.count).toBe(0);
    expect(await turnsOf(support, "u_42").list({ status: "interrupted" })).toHaveLength(2);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 6. WHAT THE SPEC CUT
// ---------------------------------------------------------------------------

describe("nothing the spec cut crept back in", () => {
  it("exposes exactly list and resume", async () => {
    const ran = { count: 0 };
    const support = parking(keep(memoryStore()), ran);
    const turns = turnsOf(support, "u_42");
    expect(Object.keys(turns).sort()).toEqual(["list", "resume"]);
    expect((turns as unknown as Record<string, unknown>).get).toBeUndefined();
    expect((turns as unknown as Record<string, unknown>).onInterruption).toBeUndefined();
  });

  it("never emits an input interruption", async () => {
    const ran = { count: 0 };
    const support = parking(keep(memoryStore()), ran);
    const asked = await interrupted(support.chat("Refund invoice 7.", { as: "u_42" }));
    const listed = await turnsOf(support, "u_42").list({ status: "interrupted" });
    expect(asked.interruptions.every((one) => one.type === "approval")).toBe(true);
    expect(listed[0]!.interruptions.every((one) => one.type === "approval")).toBe(true);
  }, 60_000);
});
