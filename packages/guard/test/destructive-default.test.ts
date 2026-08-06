import { describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { FixtureTools, call, context, descriptor } from "./fixtures/tools.js";

/**
 * The blank state, for the grade that cannot be taken back.
 *
 * `ungraded` already asked here (D3) and every preset asks or blocks on
 * `destructive` — `cautious` is the intended posture in writing. The guard's own
 * no-match default did not: with no policy configured at all it RAN a declared
 * `destructive` tool without asking, so the one install where nothing else
 * speaks — a hand-wired server — was the one install that deleted things
 * silently. Same posture as `ungraded` for the same reason: not-knowing and
 * not-undoable both need a person.
 */
describe("destructive asks by default", () => {
  it("asks for a destructive tool on a guard with NO policy config at all", async () => {
    const guard = createGuard({ store: createMemoryStore() });
    const d = descriptor("destructive", { name: "host_delete_account" });

    await expect(guard.check(call(d.name, { id: "acc_1" }), d, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "default",
    });
  });

  it("parks the call end to end rather than executing it", async () => {
    const d = descriptor("destructive", { name: "host_delete_account" });
    const guard = createGuard({ store: createMemoryStore() });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);

    const outcome = await bound.execute(call(d.name, { id: "acc_1" }, "call_delete"), context());
    expect(outcome).toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);
  });

  it("leaves reads and graded writes alone — only the irreversible grade moved", async () => {
    const guard = createGuard({ store: createMemoryStore() });
    const read = descriptor("read");
    const write = descriptor("write");

    await expect(guard.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "default",
    });
    await expect(guard.check(call(write.name), write, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "default",
    });
  });

  it("never runs it unattended either — nobody to ask is not permission", async () => {
    const d = descriptor("destructive", { name: "host_delete_account" });
    const guard = createGuard({ store: createMemoryStore() });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);

    const outcome = await bound.execute(
      call(d.name, { id: "acc_1" }, "call_delete_away"),
      context({ presence: "away", trigger: { runId: "run_1", kind: "schedule" } }),
    );
    expect(outcome.status).not.toBe("ok");
    expect(tools.executions).toHaveLength(0);
  });

  it("lets a host loosen it consciously, in writing, with a risk:destructive rule", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: { risk: "destructive" }, action: "run", note: "we accept this" }] },
    });
    const d = descriptor("destructive", { name: "host_delete_account" });

    await expect(guard.check(call(d.name), d, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "rule",
    });
  });
});
