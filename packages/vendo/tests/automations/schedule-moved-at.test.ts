/**
 * A one-shot `{ at }` that is MOVED fires at its new instant.
 *
 * `create` keeps an existing schedule cursor on a replace, so a redeploy does not
 * lose a cron's firing history. For a one-shot that same cursor carries
 * `firedAt` from the instant it already fired at, and the tick never fires an
 * `at` whose cursor has one — so re-declaring `.on({ at }, …, { id })` with a new
 * date after the first one fired armed a record that could never run.
 */
import {
  reconcileAutomations,
  type ApprovalId,
  type AuditEvent,
  type Guard,
  type RunContext,
  type ToolRegistry,
} from "../../src/core/index.js";
import { memoryStoreAdapter } from "../../src/core/conformance/index.js";
import { describe, expect, it } from "vitest";
import { automationsInternals, createAutomations } from "../../src/automations/index.js";

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

const FIRST = "2026-09-01T09:00:00.000Z";
const SECOND = "2026-10-01T09:00:00.000Z";

describe("a moved one-shot schedule", () => {
  it("fires at the new instant after the old one already fired", async () => {
    let clock = new Date("2026-08-01T00:00:00.000Z");
    const engine = createAutomations({
      tools: registry(),
      guard: new GuardDouble(),
      store: memoryStoreAdapter(),
      now: () => clock,
    });
    const internals = automationsInternals(engine);
    // The boot path `.on()` declarations take: plan against what is stored, apply.
    const deploy = async (at: string) => {
      const stored = await engine.list({}, ctx);
      const plan = reconcileAutomations(
        [{ id: "launch-recap", when: { at }, task: { kind: "steps", steps: [] } }],
        stored,
        ctx.principal,
        "code",
      );
      await internals.reconcile(plan, ctx);
    };

    await deploy(FIRST);
    clock = new Date("2026-09-01T09:01:00.000Z");
    expect(await engine.tick(clock)).toHaveLength(1);

    await deploy(SECOND);
    clock = new Date("2026-10-01T09:01:00.000Z");
    expect(await engine.tick(clock)).toHaveLength(1);
  });

  it("still fires an unchanged one-shot only once across a replace", async () => {
    let clock = new Date("2026-08-01T00:00:00.000Z");
    const engine = createAutomations({
      tools: registry(),
      guard: new GuardDouble(),
      store: memoryStoreAdapter(),
      now: () => clock,
    });
    const internals = automationsInternals(engine);
    const declare = () => internals.create({
      id: "atm_launch",
      owner: ctx.principal,
      authoredBy: "code",
      when: { at: FIRST },
      task: { kind: "steps", steps: [] },
    }, ctx);

    await declare();
    clock = new Date("2026-09-01T09:01:00.000Z");
    expect(await engine.tick(clock)).toHaveLength(1);

    await declare();
    clock = new Date("2026-09-01T09:02:00.000Z");
    expect(await engine.tick(clock)).toHaveLength(0);
  });

  it("does not re-fire a one-shot redeclared with the same instant in other ISO text", async () => {
    let clock = new Date("2026-08-01T00:00:00.000Z");
    const engine = createAutomations({
      tools: registry(),
      guard: new GuardDouble(),
      store: memoryStoreAdapter(),
      now: () => clock,
    });
    const internals = automationsInternals(engine);
    const declare = (at: string) => internals.create({
      id: "atm_launch",
      owner: ctx.principal,
      authoredBy: "code",
      when: { at },
      task: { kind: "steps", steps: [] },
    }, ctx);

    await declare(FIRST);
    clock = new Date("2026-09-01T09:01:00.000Z");
    expect(await engine.tick(clock)).toHaveLength(1);

    await declare("2026-09-01T09:00:00Z");
    clock = new Date("2026-09-01T09:02:00.000Z");
    expect(await engine.tick(clock)).toHaveLength(0);
  });
});
