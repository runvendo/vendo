/**
 * The S9 differential: the FROZEN pre-merge drivers (`tests/frozen/`) and the
 * spine-backed ones, run on the same inputs — each against its own real
 * embedded store, its own real guard and its own copy of the same scripted
 * thinker — and compared on everything a caller can observe:
 *
 *   1. the transcript rows            (`threadMessageStore.list`)
 *   2. the guard's pending feed       (`guard.approvals.pending`)
 *   3. the audit rows                 (`guard.audit.query`)
 *   4. the turn's own answer          (`TurnRecord`, or the wire bytes)
 *
 * Only the thinker is scripted, because the thinker is deliberately not what is
 * under test (CLAUDE.md: test the SEAM). Ids and clocks are normalised away by
 * {@link stable}; what survives normalisation is behaviour.
 *
 * Every intended difference is named in {@link ALLOWED} with its reason.
 * Anything else fails.
 */
import type { RunContext, ThreadId, ToolResult, TurnId } from "../../src/core/index.js";
import { createGuard } from "../../src/guard/index.js";
import { defineHarness } from "../../src/harnesses/index.js";
import { storeFiles, threadMessageStore, type VendoStore } from "../../src/store/index.js";
import { emptySharedStore } from "../../src/store/backends.test-util.js";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createSession } from "../../src/turn/session.js";
import { tool, mergeSources } from "../../src/turn/tools.js";
import { runTurn, type TurnDeps, type TurnRecord } from "../../src/turn/turn.js";
import { createSession as frozenCreateSession } from "../frozen/session-frozen.js";
import { runTurn as frozenRunTurn } from "../frozen/turn-frozen.js";

const principal = { kind: "user" as const, subject: "u_42" };

/**
 * The differences this branch INTENDS, each with the reason it is not a
 * regression. An entry is a scenario name plus the observable it excuses; every
 * other difference fails the run.
 */
const ALLOWED: Record<string, string> = {
  // (empty — the merge is meant to be observationally identical. Anything that
  // has to go in here is a decision, not a detail.)
};

/** A destructive tool is what makes the guard park: it can be traced to no
 *  grant, so it needs a person. */
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

/** A thinker that calls `refund` `calls` times and then speaks. Re-created per
 *  side, so the two sides never share its turn counter. */
const thinker = (calls: number) =>
  defineHarness({
    name: "differ",
    async *run(turn) {
      for (let i = 0; i < calls; i += 1) {
        const result: ToolResult = await turn.tools.call("refund", {});
        yield { type: "text" as const, delta: `[${result.status}]` };
      }
      yield { type: "text" as const, delta: "done" };
    },
  });

interface World {
  store: VendoStore;
  guard: ReturnType<typeof createGuard>;
  deps: TurnDeps;
  tools: ReturnType<ReturnType<typeof createGuard>["bind"]>;
  ran: { count: number };
}

/** One side's whole world: an empty store, its own guard, its own thinker. The
 *  same construction both sides get, so a difference can only come from the
 *  driver. The two sides are built and observed strictly in sequence, so they
 *  can share the file's one engine. */
const world = async (calls: number): Promise<World> => {
  const store = await emptySharedStore();
  const ran = { count: 0 };
  // The agent()-composition TTL (agent.ts): a parked turn waits for a PERSON.
  const guard = createGuard({ store, approvals: { parkedCallTtlMs: 7 * 24 * 60 * 60 * 1000 } });
  const tools = guard.bind(mergeSources([refundTool(ran)], []));
  return { store, guard, tools, ran, deps: { harness: thinker(calls), store, guard } };
};

const VOLATILE = /^(id|.*Id|createdAt|updatedAt|at|timestamp|ts|expiresAt|durationMs)$/;
const UUIDISH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b(msg|thr|trn|apr|run|evt)_[0-9a-z-]+/gi;
/** Tool-call and text-part ids carry a counter that is global to the PROCESS,
 *  so the second side of a comparison starts where the first left off. The
 *  counter is not behaviour; the sequence it appears in is. */
const COUNTED = /\b(hcall|txt)_\d+_/gi;

/** The same value with everything that legitimately differs between two runs —
 *  minted ids, clocks — replaced by a constant. Keys are sorted so property
 *  order cannot masquerade as a behaviour change. */
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !VOLATILE.test(key))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, inner]) => [key, stable(inner)]),
    );
  }
  if (typeof value === "string") return value.replace(COUNTED, "$1_<n>_").replace(UUIDISH, "<id>");
  // Epoch-milliseconds and wall-clock durations are never behaviour.
  if (typeof value === "number" && value > 1e12) return "<time>";
  return value;
};

/** The three store-and-guard-side observables, for either side. */
const observe = async (w: World, threadId: string): Promise<unknown> => ({
  transcript: stable(await threadMessageStore<UIMessage>(w.store).list(principal, threadId as ThreadId)),
  pending: stable(
    (await w.guard.approvals.pending(principal))
      .map((request) => ({
        tool: request.call.tool,
        venue: request.ctx.venue,
        presence: request.ctx.presence,
        status: "pending",
      }))
      .sort((a, b) => (a.tool < b.tool ? -1 : 1)),
  ),
  audit: stable((await w.guard.audit.query({})).events),
  ran: w.ran.count,
});

const ctxFor = (presence: "present" | "away", threadId: string): RunContext => ({
  principal,
  venue: "chat",
  presence,
  sessionId: threadId,
});

// 32 lowercase hex, because `turnIdSchema` pins the WHOLE shape
// (`/^trn_[0-9a-f]{32}$/`, core/src/ids.ts) — a turn id the guard cannot parse
// never reaches a park, and the scenario silently degrades to a plain error.
const THREAD = "thr_5900000000000000000000000000d1ff" as ThreadId;
const TURN = "trn_5900000000000000000000000000cafe" as TurnId;

/** One scenario, run on both sides. */
interface Scenario {
  name: string;
  presence: "present" | "away";
  /** How many tool calls the thinker attempts. */
  calls: number;
  /** The turn's budget — 1 with 2 calls is the budget-hit arm. */
  maxToolCalls: number;
}

/**
 * The matrix the review package asks for, on the lane that owns
 * `interactive: false`: presence × park × budget.
 *
 * `calls: 0` is the no-park arm; `calls: 1` parks (the tool is destructive);
 * `calls: 2, maxToolCalls: 1` spends the budget on the park and then refuses.
 */
const SCENARIOS: readonly Scenario[] = [
  { name: "away · no park", presence: "away", calls: 0, maxToolCalls: 20 },
  { name: "present · no park", presence: "present", calls: 0, maxToolCalls: 20 },
  { name: "away · park", presence: "away", calls: 1, maxToolCalls: 20 },
  { name: "present · park", presence: "present", calls: 1, maxToolCalls: 20 },
  { name: "away · park · budget hit", presence: "away", calls: 2, maxToolCalls: 1 },
  { name: "present · park · budget hit", presence: "present", calls: 2, maxToolCalls: 1 },
];

/** The record, minus the ids that differ per run. */
const recordShape = (record: TurnRecord): unknown => stable({
  text: record.text,
  toolCalls: record.toolCalls.map((entry) => ({ tool: entry.call.tool, outcome: entry.outcome })),
  parked: record.parked.map((request) => request.call.tool),
  stopped: record.stopped ?? null,
  failed: record.failed === undefined ? null : "failed",
  usage: record.usage,
});

describe("S9 differential · the unattended lane (interactive: false)", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} — frozen and spine agree`, async () => {
      const run = async (
        driver: typeof runTurn,
      ): Promise<{ record: unknown; observed: unknown }> => {
        const w = await world(scenario.calls);
        const record = await driver(w.deps, {
          prompt: "Refund invoice 7.",
          tools: w.tools,
          ctx: ctxFor(scenario.presence, THREAD),
          threadId: THREAD,
          turnId: TURN,
          reopen: false,
          maxToolCalls: scenario.maxToolCalls,
        });
        return { record: recordShape(record), observed: await observe(w, THREAD) };
      };

      const frozen = await run(frozenRunTurn);
      const spine = await run(runTurn);

      expect(ALLOWED[scenario.name]).toBeUndefined();
      expect(spine.record).toEqual(frozen.record);
      expect(spine.observed).toEqual(frozen.observed);
    });
  }

  it("a resumed park re-dispatches identically on both sides", async () => {
    const resumeOn = async (
      driver: typeof runTurn,
    ): Promise<{ first: unknown; second: unknown; observed: unknown }> => {
      const w = await world(1);
      const ctx = ctxFor("present", THREAD);
      const first = await driver(w.deps, {
        prompt: "Refund invoice 7.",
        tools: w.tools,
        ctx,
        threadId: THREAD,
        turnId: TURN,
        reopen: false,
        maxToolCalls: 20,
      });
      // The card the first turn left standing, answered the way `turns.resume`
      // answers it — through the real guard, never a stub.
      const decisions = Object.fromEntries(first.parked.map((request) => [request.id, "approve" as const]));
      const second = await driver(w.deps, {
        prompt: "",
        tools: w.tools,
        ctx,
        threadId: THREAD,
        turnId: TURN,
        reopen: true,
        maxToolCalls: 20,
        resume: { guard: w.guard, parked: first.parked, decisions },
      });
      return {
        first: recordShape(first),
        second: recordShape(second),
        observed: await observe(w, THREAD),
      };
    };

    const frozen = await resumeOn(frozenRunTurn);
    const spine = await resumeOn(runTurn);

    expect(spine.first).toEqual(frozen.first);
    expect(spine.second).toEqual(frozen.second);
    expect(spine.observed).toEqual(frozen.observed);
  });
});

describe("S9 differential · the streaming lane (interactive: true)", () => {
  /** The wire, with its minted ids normalised — the chunk SEQUENCE is what is
   *  being compared, not the ids inside it. */
  const chunks = (body: string): unknown =>
    stable(body.split("\n").filter((line) => line.length > 0));

  const sessionRun = async (
    driver: typeof createSession,
    calls: number,
    autoApprove: boolean,
  ): Promise<{ wire: unknown; observed: unknown }> => {
    const w = await world(calls);
    // `interactive: true` BLOCKS on the tap. This is the tap — the guard's own
    // subscription, which is exactly what `session.on("approval")` rides.
    if (autoApprove) {
      w.guard.onApprovalRequested?.((request) => {
        void w.guard.approvals.decide([request.id], { approve: true }, principal);
      });
    }
    const session = await driver(
      {
        name: "support",
        harness: w.deps.harness,
        store: w.store,
        guard: w.guard,
        tools: w.tools,
        skills: [],
        files: storeFiles(w.store),
      },
      "u_42",
    );
    const body = await (await session.stream("Refund invoice 7.")).text();
    return { wire: chunks(body), observed: await observe(w, session.threadId) };
  };

  for (const [name, calls, autoApprove] of [
    ["no park", 0, false],
    ["park, approved by the tap", 1, true],
  ] as const) {
    it(`${name} — frozen and spine agree`, async () => {
      const frozen = await sessionRun(frozenCreateSession, calls, autoApprove);
      const spine = await sessionRun(createSession, calls, autoApprove);

      expect(ALLOWED[name]).toBeUndefined();
      expect(spine.wire).toEqual(frozen.wire);
      expect(spine.observed).toEqual(frozen.observed);
    });
  }
});
