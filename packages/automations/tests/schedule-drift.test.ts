/**
 * Schedule PHASE: a fired window's cursor is the time that window was DUE, never
 * the clock the tick happened to read.
 *
 * A heartbeat calls tick() once a minute, and the tick spends a jittering second
 * or so on ready(), auth and a store round trip before it writes the cursor.
 * Storing that observed time made every fire the anchor for the next one, so the
 * due time crept later than the heartbeat until a whole window slipped under it
 * and a `{ every: "1m" }` record fired every OTHER minute (observed against Vendo
 * Cloud: gaps of 2m, 2m, 2m, 1m).
 */
import {
  type ApprovalId,
  type AuditEvent,
  type Guard,
  type RunContext,
  type StoreAdapter,
  type ToolRegistry,
  type When,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { describe, expect, it } from "vitest";
import { automationsInternals, createAutomations, type AutomationsEngine } from "../src/index.js";
import { SCHEDULE } from "../src/types.js";

const START = new Date("2026-07-12T12:00:00.000Z");
const MINUTE = 60_000;

/** What each heartbeat's tick spent before reaching the cursor write. It
 *  JITTERS, because a tick that gets there QUICKER than the one before it is
 *  what used to land just under due and lose the window. */
const LATENCY_MS = [1_000, 1_500, 1_000, 1_500, 1_000, 1_500];

/** The minute each heartbeat was for — what the cursor should hold afterwards. */
const WINDOWS = LATENCY_MS.map((_, index) => new Date(START.getTime() + (index + 1) * MINUTE).toISOString());

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_a" },
  venue: "chat",
  presence: "present",
  sessionId: "session_a",
};

class GuardDouble implements Guard {
  async check(): Promise<{ action: "run"; decidedBy: "default" }> { return { action: "run", decidedBy: "default" }; }
  async report(_event: AuditEvent): Promise<void> { return undefined; }
  async directions(): Promise<string[]> { return []; }
  onApprovalDecision(_callback: (id: ApprovalId, approved: boolean) => void): () => void { return () => undefined; }
}

const registry = (): ToolRegistry => ({
  async descriptors() { return []; },
  async execute() { return { status: "ok", output: {} }; },
});

/** A schedule whose cursor `create` anchors at START, so the first heartbeat is
 *  its first window. */
const scheduled = async (when: When): Promise<{ store: StoreAdapter; engine: AutomationsEngine; id: string }> => {
  const store = memoryStoreAdapter();
  const engine = createAutomations({ tools: registry(), guard: new GuardDouble(), store, now: () => START });
  const { id } = await automationsInternals(engine).create(
    { id: "atm_phase", owner: ctx.principal, authoredBy: "code", when, task: { kind: "steps", steps: [] } },
    ctx,
  );
  return { store, engine, id };
};

/** Six once-a-minute heartbeats: what fired on each, and where the cursor
 *  landed after it. */
const heartbeats = async (
  { store, engine, id }: { store: StoreAdapter; engine: AutomationsEngine; id: string },
): Promise<{ fired: number[]; cursors: Array<string | undefined> }> => {
  const fired: number[] = [];
  const cursors: Array<string | undefined> = [];
  for (const [index, latency] of LATENCY_MS.entries()) {
    fired.push((await engine.tick(new Date(START.getTime() + (index + 1) * MINUTE + latency))).length);
    const cursor = await store.records(SCHEDULE).get(id);
    cursors.push((cursor?.data as { lastFiredAt?: string } | undefined)?.lastFiredAt);
  }
  return { fired, cursors };
};

describe("schedule phase under a slow tick", () => {
  it("fires an `every` interval on EVERY window, however long each tick took to get there", async () => {
    const { fired, cursors } = await heartbeats(await scheduled({ every: "1m" }));

    expect(fired).toEqual([1, 1, 1, 1, 1, 1]);
    expect(cursors).toEqual(WINDOWS);
  });

  // The cron equivalent, and the reason only the interval needed fixing: croner
  // re-anchors to the pattern's own grid, and the clock a tick reads always sits
  // in the same gap between occurrences as the window it fired, so the same
  // heartbeat that lost every other `every` window loses no cron window. This
  // holds the property while the interval beside it changes.
  it("holds a cron on every window under the same heartbeat", async () => {
    const { fired } = await heartbeats(await scheduled("* * * * *"));

    expect(fired).toEqual([1, 1, 1, 1, 1, 1]);
  });
});
