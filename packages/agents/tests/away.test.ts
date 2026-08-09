/**
 * The away entry: one non-interactive harness run per firing, reported as core's
 * `AgentRunReport`. Real embedded store, real guard, real `createHarnessRuntime` —
 * only the thinker is scripted, because the thinker is not what is under test
 * (CLAUDE.md: test the SEAM).
 */
import {
  agentRunReportSchema,
  descriptorHash,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
  type Turn,
} from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, threadMessageStore, threadStore, type VendoStore } from "@vendoai/store";
import { describe, expect, it } from "vitest";
import { awayRunner } from "../src/away.js";

let stores = 0;
const memoryStore = (): VendoStore => createStore({ dataDir: `memory://agents-away-${stores++}` });

const readDescriptor: ToolDescriptor = {
  name: "invoices_list",
  description: "List invoices",
  inputSchema: { type: "object" },
  risk: "read",
};

/** The engine's fire-time ctx: the sponsor, venue "automation", presence "away",
 *  and the firing trigger's own id. */
const fireCtx = (): RunContext => ({
  principal: { kind: "user", subject: "u_owner" },
  venue: "automation",
  presence: "away",
  sessionId: "sess_run_1",
  appId: "app_digest",
  trigger: { runId: "run_1", kind: "host-event", id: "nightly" },
});

/** A registry the runner is HANDED (the engine passes the task's guard-bound one),
 *  recording what it was asked to do. */
function taskRegistry(over: Partial<ToolRegistry> = {}): ToolRegistry & { calls: string[]; ctxs: Array<RunContext | undefined> } {
  const calls: string[] = [];
  const ctxs: Array<RunContext | undefined> = [];
  return {
    calls,
    ctxs,
    async descriptors(ctx) {
      ctxs.push(ctx as RunContext | undefined);
      return [readDescriptor];
    },
    async execute(call) {
      calls.push(call.tool);
      return { status: "ok", output: { invoices: 2 } };
    },
    ...over,
  };
}

const deps = (store: VendoStore, harness: Parameters<typeof awayRunner>[0]["harness"]) => ({
  harness,
  store,
  guard: createGuard({ store }),
});

/**
 * The app-bound automation grant an armed trigger runs on, seeded as a row —
 * the same shape `automations` mints at arm time and the same thing sibling
 * packages' unit tests seed. 05 §6: a grant is the ONLY thing that authorizes an
 * away call, so nothing at all executes in an away run without one.
 */
async function armTrigger(store: VendoStore): Promise<void> {
  const grant = {
    id: "grt_seeded",
    subject: "u_owner",
    tool: readDescriptor.name,
    descriptorHash: descriptorHash(readDescriptor),
    scope: { kind: "tool" as const },
    duration: "standing" as const,
    appId: "app_digest",
    triggerId: "nightly",
    source: "automation" as const,
    grantedAt: new Date().toISOString(),
  };
  await store.records("vendo_grants").put({
    id: grant.id,
    data: grant,
    refs: { subject: grant.subject, tool: grant.tool, app_id: grant.appId, trigger_id: grant.triggerId },
  });
}

describe("awayRunner", () => {
  it("returns a schema-valid report whose summary is the harness's own words", async () => {
    const store = memoryStore();
    const run = awayRunner(deps(store, defineHarness({
      name: "scripted",
      async *run() {
        yield { type: "text" as const, delta: "Two invoices are outstanding." };
      },
    })));

    const report = await run({ prompt: "Check the invoices.", tools: taskRegistry() }, fireCtx());

    expect(agentRunReportSchema.parse(report)).toBeTruthy();
    expect(report.status).toBe("ok");
    expect(report.summary).toBe("Two invoices are outstanding.");
  });

  it("a hot-path commit paints in an away run too, and the part persists to the run's thread (§1.6)", async () => {
    // Regression pin, same as the session suite's: the render seam rides the
    // runtime's injected `wrapWorkspace` slot, and the away entry has to fill
    // it — unfilled, an unattended build's screen never paints and the run's
    // thread holds no view for the sponsor to open.
    const store = memoryStore();
    const run = awayRunner(deps(store, defineHarness({
      name: "builder",
      async *run(turn) {
        await turn.workspace.writeFile(
          "/user/apps/app_digest/plan.vendo",
          `<Plan name="Invoices"><Group title="Unpaid"><Leaf component="DataTable" /></Group></Plan>`,
        );
        yield { type: "text" as const, delta: "**Summary:** sketched the digest screen." };
      },
    })));

    const report = await run({ prompt: "Build the digest screen.", tools: taskRegistry() }, fireCtx());
    expect(report.status).toBe("ok");

    const principal = fireCtx().principal;
    const [thread] = await threadStore(store).list(principal);
    const messages = await threadMessageStore<{
      id: string;
      role: string;
      parts: Array<{ type: string; data?: { appId?: string } }>;
    }>(store).list(principal, thread!.id);
    const view = messages
      .find((message) => message.role === "assistant")
      ?.parts.find((part) => part.type === "data-vendo-view");
    expect(view).toBeDefined();
    expect(view?.data?.appId).toBe("app_digest");
  });

  // The run record's `summary` is contracted as a SUMMARY (07 §5 — "agentic:
  // model-written"), and the automations panel prints it VERBATIM in a run row.
  // An away turn's assistant message is the whole working narration, so a
  // succeeded run used to render thousands of characters of "I'll gather all the
  // data simultaneously… **Analysis notes:**" where a person expected a line.
  describe("summary", () => {
    /** The shape a real agentic turn leaves behind: a plan, its working notes,
     *  then the account of what happened. Comfortably past any sane cap. */
    const narration = (closing: string) => [
      "I'll gather all the data simultaneously so nothing waits on anything else.",
      `**Analysis notes:**\n${Array.from({ length: 40 }, (_, index) => `- Checked ledger page ${index + 1} for unpaid invoices and matched it against the payments feed.`).join("\n")}`,
      "Cross-referencing the payment feed against the ledger to be sure nothing double-counts.",
      closing,
    ].join("\n\n");

    const summaryOf = async (text: string): Promise<string> => {
      const store = memoryStore();
      const run = awayRunner(deps(store, defineHarness({
        name: "narrator",
        async *run() {
          yield { type: "text" as const, delta: text };
        },
      })));
      const report = await run({ prompt: "Check the invoices.", tools: taskRegistry() }, fireCtx());
      return report.summary;
    };

    it("reports the section the model MARKED as its summary, not the narration around it", async () => {
      const summary = await summaryOf(narration("**Summary:** 3 invoices are overdue; the digest went out."));

      expect(summary).toBe("3 invoices are overdue; the digest went out.");
    });

    it("falls back to the model's closing paragraph when it marked no summary", async () => {
      const summary = await summaryOf(narration("Nothing needed chasing — every invoice cleared on time."));

      expect(summary).toBe("Nothing needed chasing — every invoice cleared on time.");
    });

    it("caps a closing paragraph that is itself a wall of text", async () => {
      const wall = `In the end ${"the ledger and the payments feed agreed on every line item. ".repeat(30)}`;

      const summary = await summaryOf(narration(wall));

      // The contracted reading budget — a few sentences, not a transcript.
      expect(summary.length).toBeLessThanOrEqual(400);
      expect(summary.startsWith("In the end")).toBe(true);
      expect(summary).not.toContain("Analysis notes");
    });

    it("leaves a reply that is already summary-sized exactly as the model wrote it", async () => {
      const spoken = "Two invoices are overdue.\n\nBoth were chased; nothing else needed doing.";

      expect(await summaryOf(spoken)).toBe(spoken);
    });
  });

  it("runs NON-interactively and preserves the firing ctx the engine built", async () => {
    const store = memoryStore();
    let seen: Turn | undefined;
    const run = awayRunner(deps(store, defineHarness({
      name: "peek",
      async *run(turn) {
        seen = turn;
        await turn.tools.list();
        yield { type: "text" as const, delta: "looked" };
      },
    })));
    const registry = taskRegistry();

    await run({ prompt: "look", tools: registry }, fireCtx());

    expect(seen?.interactive).toBe(false);
    // The registry is asked for descriptors with the FIRING ctx — venue, presence
    // and the trigger id intact, because the guard's away-grant lookup matches on it.
    const asked = registry.ctxs.find((ctx) => ctx !== undefined);
    expect(asked).toMatchObject({
      venue: "automation",
      presence: "away",
      appId: "app_digest",
      trigger: { id: "nightly", runId: "run_1" },
    });
  });

  it("is the TASK's registry that the harness may call, not one of its own", async () => {
    const store = memoryStore();
    const run = awayRunner(deps(store, defineHarness({
      name: "caller",
      async *run(turn) {
        const listed = await turn.tools.list();
        yield { type: "text" as const, delta: listed.map((tool) => tool.name).join(",") };
      },
    })));

    const report = await run({ prompt: "list", tools: taskRegistry() }, fireCtx());

    expect(report.summary).toBe("invoices_list");
  });

  it("records every guarded call it made, with the outcome the guard returned", async () => {
    const store = memoryStore();
    const guard = createGuard({ store });
    const registry = taskRegistry();
    const run = awayRunner({
      store,
      guard,
      harness: defineHarness({
        name: "caller",
        async *run(turn) {
          await turn.tools.call("invoices_list", {});
          yield { type: "text" as const, delta: "done" };
        },
      }),
    });

    await store.ensureSchema();
    await armTrigger(store);
    const report = await run({ prompt: "read", tools: registry }, fireCtx());

    expect(registry.calls).toEqual(["invoices_list"]);
    expect(report.toolCalls.map(({ call, outcome }) => [call.tool, outcome]))
      .toEqual([["invoices_list", "ok"]]);
  });

  it("records a call nobody was there to approve as pending, and never runs it", async () => {
    const store = memoryStore();
    const registry = taskRegistry();
    // No grant and no allowing rule: an away call the guard wants a person for.
    const run = awayRunner(deps(store, defineHarness({
      name: "caller",
      async *run(turn) {
        await turn.tools.call("invoices_list", {});
        yield { type: "text" as const, delta: "asked" };
      },
    })));

    const report = await run({ prompt: "read", tools: registry }, fireCtx());

    expect(registry.calls).toEqual([]);
    expect(report.toolCalls.map(({ call, outcome }) => [call.tool, outcome]))
      .toEqual([["invoices_list", "pending-approval"]]);
  });

  it("honors budget.maxToolCalls: the call past the budget never reaches the registry, and the run is stopped", async () => {
    const store = memoryStore();
    const guard = createGuard({ store });
    const registry = taskRegistry();
    const run = awayRunner({
      store,
      guard,
      harness: defineHarness({
        name: "greedy",
        async *run(turn) {
          for (let attempt = 0; attempt < 4; attempt += 1) await turn.tools.call("invoices_list", {});
          yield { type: "text" as const, delta: "spent" };
        },
      }),
    });

    await store.ensureSchema();
    await armTrigger(store);
    const report = await run(
      { prompt: "loop", tools: registry, budget: { maxToolCalls: 2 } },
      fireCtx(),
    );

    expect(registry.calls).toEqual(["invoices_list", "invoices_list"]);
    expect(report.status).toBe("stopped");
  });

  it("reports a harness that fails as an error, in the consumer voice", async () => {
    const store = memoryStore();
    const run = awayRunner(deps(store, defineHarness({
      name: "broken",
      async *run() {
        yield { type: "error" as const, message: "The nightly digest could not be built." };
      },
    })));

    const report = await run({ prompt: "fail", tools: taskRegistry() }, fireCtx());

    expect(report.status).toBe("error");
    expect(report.summary).toBe("The nightly digest could not be built.");
  });

  it("reports a stop when the engine aborts the run", async () => {
    const store = memoryStore();
    const controller = new AbortController();
    const run = awayRunner(deps(store, defineHarness({
      name: "slow",
      async *run(turn) {
        controller.abort();
        // The runtime hands the harness the signal; a well-behaved thinker stops.
        if (turn.signal.aborted) return;
        yield { type: "text" as const, delta: "should not arrive" };
      },
    })));

    const report = await run(
      { prompt: "stop me", tools: taskRegistry(), abortSignal: controller.signal },
      fireCtx(),
    );

    expect(report.status).toBe("stopped");
    expect(report.summary.trim()).not.toBe("");
  });

  it("thinks on the composition's OWN brief when one is supplied, assembled for the firing ctx", async () => {
    const store = memoryStore();
    let seen: string | undefined;
    const run = awayRunner({
      store,
      guard: createGuard({ store }),
      system: (ctx) => `Brief for ${ctx.venue}/${ctx.presence} on ${String(ctx.appId)}`,
      harness: defineHarness({
        name: "peek",
        async *run(turn) {
          seen = turn.system;
          yield { type: "text" as const, delta: "ok" };
        },
      }),
    });

    await run({ prompt: "go", tools: taskRegistry() }, fireCtx());

    expect(seen).toBe("Brief for automation/away on app_digest");
  });

  it("hands that hook the default assembly and the guard's directions", async () => {
    const store = memoryStore();
    let handed: { assembled: string; directions: readonly string[] } | undefined;
    let seen: string | undefined;
    const run = awayRunner({
      store,
      guard: createGuard({ store, policy: { directions: ["Never send anything unattended."] } }),
      instructions: "Answer as the Acme desk.",
      system: (ctx, prompt) => {
        handed = prompt;
        return `Brief for ${ctx.venue}`;
      },
      harness: defineHarness({
        name: "peek",
        async *run(turn) {
          seen = turn.system;
          yield { type: "text" as const, delta: "ok" };
        },
      }),
    });

    await run({ prompt: "go", tools: taskRegistry() }, fireCtx());

    expect(seen).toBe("Brief for automation");
    expect(handed?.assembled).toContain("Answer as the Acme desk.");
    expect(handed?.directions).toEqual(["Never send anything unattended."]);
  });

  it("falls back to the default assembly when the hook declines — an away run is never promptless", async () => {
    const store = memoryStore();
    let seen: string | undefined;
    const run = awayRunner({
      store,
      guard: createGuard({ store, policy: { directions: ["Never send anything unattended."] } }),
      instructions: "Answer as the Acme desk.",
      system: () => undefined,
      harness: defineHarness({
        name: "peek",
        async *run(turn) {
          seen = turn.system;
          yield { type: "text" as const, delta: "ok" };
        },
      }),
    });

    await run({ prompt: "go", tools: taskRegistry() }, fireCtx());

    expect(seen).toContain("Answer as the Acme desk.");
    expect(seen).toContain("Never send anything unattended.");
  });

  it("assembles its own brief when the host supplied none: instructions plus the guard's directions", async () => {
    const store = memoryStore();
    let seen: string | undefined;
    const run = awayRunner({
      store,
      guard: createGuard({ store, policy: { directions: ["Never send anything unattended."] } }),
      instructions: "Answer as the Acme desk.",
      harness: defineHarness({
        name: "peek",
        async *run(turn) {
          seen = turn.system;
          yield { type: "text" as const, delta: "ok" };
        },
      }),
    });

    await run({ prompt: "go", tools: taskRegistry() }, fireCtx());

    expect(seen).toContain("Answer as the Acme desk.");
    expect(seen).toContain("Never send anything unattended.");
  });

  it("mounts the automation owner's DURABLE workspace: a note one run writes, the next run reads", async () => {
    const store = memoryStore();
    const guard = createGuard({ store });
    const write = awayRunner({
      harness: defineHarness({
        name: "writer",
        async *run(turn) {
          await turn.workspace.writeFile("/user/memory/digest.md", "3 invoices last night");
          yield { type: "text" as const, delta: "noted" };
        },
      }),
      store,
      guard,
    });
    const read = awayRunner({
      harness: defineHarness({
        name: "reader",
        async *run(turn) {
          yield { type: "text" as const, delta: await turn.workspace.readFile("/user/memory/digest.md") };
        },
      }),
      store,
      guard,
    });

    await write({ prompt: "note it", tools: taskRegistry() }, fireCtx());
    const second = await read({ prompt: "recall it", tools: taskRegistry() }, fireCtx());

    expect(second.summary).toBe("3 invoices last night");
  });
});
