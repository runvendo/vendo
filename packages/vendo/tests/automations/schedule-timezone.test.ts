/**
 * An automation's `timezone` is checked when it is created, the way its cron
 * already is. croner accepts any string at construction and only throws
 * ("Invalid time zone specified") when it computes a run, so a timezone nobody
 * can resolve used to be stored and armed, then throw inside the shared tick:
 * every other schedule in the deployment stopped firing with it.
 */
import {
  type ApprovalId,
  type AuditEvent,
  type Guard,
  type RunContext,
  type ToolRegistry,
} from "../../src/core/index.js";
import { memoryStoreAdapter } from "../../src/core/conformance/index.js";
import { describe, expect, it } from "vitest";
import { automationsInternals, createAutomations } from "../../src/automations/index.js";

const START = new Date("2026-07-12T12:00:00.000Z");
const MINUTE = 60_000;

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

const engineAt = () => createAutomations({
  tools: registry(),
  guard: new GuardDouble(),
  store: memoryStoreAdapter(),
  now: () => START,
});

describe("automation timezone", () => {
  it("refuses a timezone croner cannot resolve at create, instead of storing it", async () => {
    const engine = engineAt();
    await expect(automationsInternals(engine).create({
      owner: ctx.principal,
      authoredBy: "chat",
      when: "0 9 * * *",
      timezone: "America/New York",
      task: { kind: "steps", steps: [] },
    }, ctx)).rejects.toMatchObject({ code: "validation" });
    expect(await engine.list({}, ctx)).toEqual([]);
  });

  it("keeps every other schedule firing after a bad timezone was offered", async () => {
    const engine = engineAt();
    const internals = automationsInternals(engine);
    await internals.create({
      id: "atm_good",
      owner: ctx.principal,
      authoredBy: "code",
      when: "* * * * *",
      task: { kind: "steps", steps: [] },
    }, ctx);
    await internals.create({
      owner: ctx.principal,
      authoredBy: "chat",
      when: "* * * * *",
      timezone: "Pacific Time",
      task: { kind: "steps", steps: [] },
    }, ctx).catch(() => undefined);

    const fired = await engine.tick(new Date(START.getTime() + MINUTE + 1_000));

    expect(fired).toHaveLength(1);
  });

  it("refuses a whole reconcile plan with a bad timezone before writing any of it", async () => {
    const engine = engineAt();
    const plan = {
      create: [
        { id: "atm_first", owner: ctx.principal, authoredBy: "code" as const, when: "0 9 * * *", task: { kind: "steps" as const, steps: [] } },
        { id: "atm_second", owner: ctx.principal, authoredBy: "code" as const, when: "0 9 * * *", timezone: "Pacific Time", task: { kind: "steps" as const, steps: [] } },
      ],
      disarm: [],
    };

    await expect(automationsInternals(engine).reconcile(plan, ctx)).rejects.toMatchObject({ code: "validation" });
    expect(await engine.list({}, ctx)).toEqual([]);
  });

  it("still accepts IANA names and the aliases croner resolves", async () => {
    const internals = automationsInternals(engineAt());
    for (const timezone of ["America/New_York", "Europe/London", "UTC", "EST"]) {
      await expect(internals.create({
        owner: ctx.principal,
        authoredBy: "chat",
        when: "0 9 * * *",
        timezone,
        task: { kind: "steps", steps: [] },
      }, ctx)).resolves.toMatchObject({ timezone });
    }
  });
});
