/**
 * `run({ identity })` — WHICH automation an unattended run is, so the standing
 * grants `arm()` minted for it are the ones the guard matches and the run
 * proceeds instead of parking.
 *
 * It is a lookup KEY and nothing else: naming an app and a trigger nobody armed
 * buys a run exactly nothing, which is what the first and third cases here say.
 * Real store, real guard, real arming — only the thinker is scripted (CLAUDE.md:
 * test the SEAM).
 */
import { defineHarness } from "@vendoai/harnesses";
import { createGuard, type VendoGuard } from "@vendoai/guard";
import { createStore, type VendoStore } from "@vendoai/store";
import { describe, expect, it } from "vitest";
import { agent, type AgentConfig, type VendoAgent } from "../src/agent.js";
import { tool } from "../src/tools.js";

let stores = 0;
const memoryStore = (): VendoStore => createStore({ dataDir: `memory://agents-identity-${stores++}` });

const principal = { kind: "user", subject: "u_owner" } as const;
const APP = "app_digest";

/** One tool, called once, then the model speaks. */
const caller = defineHarness({
  name: "caller",
  async *run(turn) {
    await turn.tools.call("invoices_list", {});
    yield { type: "text" as const, delta: "done" };
  },
});

function compose(over: Partial<AgentConfig> = {}): { guard: VendoGuard; support: VendoAgent } {
  const store = memoryStore();
  const guard = createGuard({ store });
  const support = agent({
    name: "support",
    harness: caller,
    tools: [tool({
      name: "invoices_list",
      description: "List invoices",
      risk: "read",
      inputSchema: { type: "object" },
      execute: () => ({ invoices: 2 }),
    })],
    store,
    guard,
    ...over,
  });
  return { guard, support };
}

/** Arm the named trigger and answer yes, exactly as a person would. */
const armAndAllow = async (guard: VendoGuard, support: VendoAgent, triggerId: string): Promise<void> => {
  const { pending } = await support.arm(principal.subject, { appId: APP, triggerId });
  await guard.approvals.decide(pending, { approve: true }, principal);
};

describe("run({ identity })", () => {
  it("parks every call when nobody armed that identity", async () => {
    const { support } = compose();

    const report = await support.run("Send the digest.", {
      as: principal.subject,
      identity: { appId: APP, triggerId: "nightly" },
    });

    expect(report.toolCalls.map(({ outcome }) => outcome)).toEqual(["pending-approval"]);
    expect(report.refs.approvals).toHaveLength(1);
  });

  it("runs unattended on the grant arm() minted, and the call is decided BY that grant", async () => {
    const { guard, support } = compose();
    await armAndAllow(guard, support, "nightly");

    const report = await support.run("Send the digest.", {
      as: principal.subject,
      identity: { appId: APP, triggerId: "nightly" },
    });

    expect(report.toolCalls.map(({ outcome }) => outcome)).toEqual(["ok"]);
    expect(report.refs.approvals).toEqual([]);
    const { events } = await guard.audit.query({ principal });
    expect(events.find((event) => event.kind === "tool-call")?.decidedBy).toBe("grant");
  });

  it("holds nothing for a SIBLING trigger of the same app", async () => {
    const { guard, support } = compose();
    await armAndAllow(guard, support, "nightly");

    const report = await support.run("Send the digest.", {
      as: principal.subject,
      identity: { appId: APP, triggerId: "weekly" },
    });

    expect(report.toolCalls.map(({ outcome }) => outcome)).toEqual(["pending-approval"]);
  });

  it("falls back to the agent's own identity when a run names none", async () => {
    const { guard, support } = compose({ identity: { appId: APP, triggerId: "nightly" } });
    await armAndAllow(guard, support, "nightly");

    const report = await support.run("Send the digest.", { as: principal.subject });

    expect(report.toolCalls.map(({ outcome }) => outcome)).toEqual(["ok"]);
  });
});
