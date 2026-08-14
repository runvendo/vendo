/**
 * The code lane — `agent.run(task)`. Real embedded store, real guard, real
 * runtime; only the thinker is scripted (CLAUDE.md: test the SEAM).
 */
import { VendoError, agentRunReportSchema } from "@vendoai/core";
import type { VendoGuard } from "@vendoai/guard";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, threadStore } from "@vendoai/store";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agent } from "../src/agent.js";
import { startRun, type RunEvent } from "../src/away.js";
import { tool } from "../src/tools.js";

let stores = 0;
const memoryStore = () => createStore({ dataDir: `memory://agents-run-${stores++}` });

const readTool = () => tool({
  name: "invoices_list",
  description: "List invoices",
  risk: "read",
  inputSchema: { type: "object" },
  execute: () => ({ invoices: 2 }),
});

/**
 * A guard that says yes.
 *
 * The REAL guard parks every away call it cannot trace to an app-bound
 * automation grant (guard.ts:1052) — which is its own test below, and is the
 * whole reason `refs.approvals` exists. The rails under test here (the budget
 * gate, the event lane, the report) sit on the far side of that decision, so
 * they need a run where calls actually execute.
 */
const permissive = (): VendoGuard => ({
  check: async () => ({ action: "run", decidedBy: "grant" }),
  previewCheck: async () => ({ action: "run", decidedBy: "grant" }),
  report: async () => {},
  directions: async () => [],
  onApprovalDecision: () => () => {},
  onApprovalRequested: () => () => {},
  bind: (tools) => tools,
  approvals: { parkedCallTtlMs: 0, pending: async () => [], decide: async () => {}, revoke: async () => {} },
  freeze: async () => {},
  unfreeze: async () => {},
  frozen: async () => false,
  grants: { list: async () => [], revoke: async () => {} },
  audit: { query: async () => ({ events: [] }), export: async function* () {} },
  status: () => ({ posture: "unconfigured" }),
});

const collect = async (events: AsyncIterable<RunEvent>): Promise<RunEvent[]> => {
  const seen: RunEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};

describe("run()", () => {
  it("reports what the run left behind: the core report, the thread, the calls and the usage", async () => {
    const store = memoryStore();
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "worker",
        async *run(turn) {
          await turn.tools.call("invoices_list", {});
          yield { type: "usage" as const, inputTokens: 11, outputTokens: 7, model: "fake-1" };
          yield { type: "text" as const, delta: "Two invoices are outstanding." };
        },
      }),
      tools: [readTool()],
      guard: permissive(),
      store,
    });

    const running = support.run("Check the invoices.", { as: "u_42" });
    // Readable BEFORE the report — a caller can show it or hand it back.
    expect(running.threadId).toMatch(/^thr_/);
    const report = await running;

    expect(agentRunReportSchema.parse(report)).toBeTruthy();
    expect(report.status).toBe("ok");
    expect(report.summary).toBe("Two invoices are outstanding.");
    expect(report.toolCalls.map(({ call, outcome }) => [call.tool, outcome]))
      .toEqual([["invoices_list", "ok"]]);
    expect(report.refs).toEqual({ threadId: running.threadId, approvals: [] });
    expect(report.usage).toEqual({ inputTokens: 11, outputTokens: 7, model: "fake-1" });
    expect(report.output).toBeUndefined();
    // The thread is real and belongs to the subject that ran.
    expect(await threadStore(store).get({ kind: "user", subject: "u_42" }, running.threadId as never))
      .not.toBeNull();
  });

  it("runs as the AGENT itself when the caller names no subject", async () => {
    const store = memoryStore();
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "peek",
        async *run() {
          yield { type: "text" as const, delta: "ok" };
        },
      }),
      store,
    });

    const running = support.run("go");
    await running;

    const owner = { kind: "user" as const, subject: "vendo:agent:support" };
    expect(await threadStore(store).get(owner, running.threadId as never)).not.toBeNull();
  });

  it("streams the five event types while the run is still going", async () => {
    const store = memoryStore();
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "noisy",
        async *run(turn) {
          yield { type: "status" as const, label: "Reading the ledger" };
          await turn.tools.call("invoices_list", {});
          yield { type: "text" as const, delta: "Two invoices." };
          yield { type: "error" as const, message: "The digest could not be sent." };
        },
      }),
      tools: [readTool()],
      guard: permissive(),
      store,
    });

    const running = support.run("Check the invoices.", { as: "u_42" });
    const events = await collect(running.events);
    await running;

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["status", "tool-call", "tool-result", "text", "error"]),
    );
    expect(events).toContainEqual({ type: "status", label: "Reading the ledger" });
    expect(events).toContainEqual({ type: "text", delta: "Two invoices." });
    expect(events).toContainEqual({ type: "error", message: "The digest could not be sent." });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool-call", tool: "invoices_list", args: {} }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool-result", tool: "invoices_list", outcome: "ok" }),
    );
  });

  it("keeps nothing for a consumer that never arrived", async () => {
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "noisy",
        async *run() {
          yield { type: "status" as const, label: "Reading the ledger" };
          yield { type: "text" as const, delta: "Two invoices." };
        },
      }),
      store: memoryStore(),
    });

    const running = support.run("Check the invoices.", { as: "u_42" });
    await running;

    // Nobody read while it ran, so the run buffered nothing on the way — a run
    // whose events nobody watches must not grow with what it says.
    expect(await collect(running.events)).toEqual([]);
  });

  it("gives a reader everything said after it attached, and refuses a second one", async () => {
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "noisy",
        async *run() {
          yield { type: "status" as const, label: "Reading the ledger" };
          yield { type: "text" as const, delta: "Two invoices." };
        },
      }),
      store: memoryStore(),
    });

    const running = support.run("Check the invoices.", { as: "u_42" });
    expect(await collect(running.events)).toEqual([
      { type: "status", label: "Reading the ledger" },
      { type: "text", delta: "Two invoices." },
    ]);
    await running;

    const second = await collect(running.events).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(VendoError);
    expect((second as VendoError).code).toBe("validation");
    expect((second as VendoError).message).toMatch(/run\.events is single-reader/);
  });

  it("keeps nothing for a reader that broke off, and lets a replacement take its seat", async () => {
    let readerLeft!: () => void;
    const afterBreak = new Promise<void>((resolve) => { readerLeft = resolve; });
    let saidUnheard!: () => void;
    const unheard = new Promise<void>((resolve) => { saidUnheard = resolve; });
    let replacementReading!: () => void;
    const afterReplacement = new Promise<void>((resolve) => { replacementReading = resolve; });
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "noisy",
        async *run() {
          yield { type: "status" as const, label: "Reading the ledger" };
          await afterBreak;
          yield { type: "text" as const, delta: "Nobody was listening for this." };
          saidUnheard();
          await afterReplacement;
          yield { type: "text" as const, delta: "Two invoices." };
        },
      }),
      store: memoryStore(),
    });

    const running = support.run("Check the invoices.", { as: "u_42" });
    const seen: RunEvent[] = [];
    for await (const event of running.events) {
      seen.push(event);
      break;
    }
    expect(seen).toEqual([{ type: "status", label: "Reading the ledger" }]);

    readerLeft();
    await unheard;
    const replacement = collect(running.events);
    replacementReading();
    await running;

    // The replacement gets what was said after IT attached and nothing else:
    // what the run said with no reader there was dropped as it was said, never
    // stacked up for whoever might come along.
    expect(await replacement).toEqual([{ type: "text", delta: "Two invoices." }]);
  });

  it("a run nobody was there to approve finishes ok, with the cards a person has to answer", async () => {
    const store = memoryStore();
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "asker",
        async *run(turn) {
          await turn.tools.call("invoices_list", {});
          yield { type: "text" as const, delta: "asked" };
        },
      }),
      tools: [readTool()],
      store,
    });

    // No grant: the guard wants a person, and nobody is here.
    const report = await support.run("Check the invoices.", { as: "u_42" });

    expect(report.status).toBe("ok");
    expect(report.refs.approvals).toHaveLength(1);
    expect(report.refs.approvals[0]).toMatch(/^apr_/);
    expect(report.toolCalls.map(({ outcome }) => outcome)).toEqual(["pending-approval"]);
  });

  it("fills a typed output from the schema, and hands a bad shape back to the model", async () => {
    const store = memoryStore();
    const attempts: unknown[] = [];
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "reporter",
        async *run(turn) {
          attempts.push(await turn.tools.call("vendo_result", { overdue: "two" }));
          attempts.push(await turn.tools.call("vendo_result", { overdue: 2 }));
          yield { type: "text" as const, delta: "done" };
        },
      }),
      store,
    });

    const report = await support.run("Count the overdue invoices.", {
      as: "u_42",
      output: z.object({ overdue: z.number() }),
    });

    expect(report.output).toEqual({ overdue: 2 });
    expect(attempts[0]).toMatchObject({ status: "error" });
    expect(attempts[1]).toMatchObject({ status: "ok" });
  });

  it("adds no result tool when no output was asked for", async () => {
    let listed: string[] = [];
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "lister",
        async *run(turn) {
          listed = (await turn.tools.list()).map((entry) => entry.name);
          yield { type: "text" as const, delta: "listed" };
        },
      }),
      tools: [readTool()],
      store: memoryStore(),
    });

    await support.run("What can you do?", { as: "u_42" });

    expect(listed).not.toContain("vendo_result");
  });

  it("stops at the default budget of 20 tool calls", async () => {
    const store = memoryStore();
    let attempted = 0;
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "greedy",
        async *run(turn) {
          for (let index = 0; index < 25; index += 1) {
            const result = await turn.tools.call("invoices_list", {});
            if (result.status === "ok") attempted += 1;
          }
          yield { type: "text" as const, delta: "spent" };
        },
      }),
      tools: [readTool()],
      guard: permissive(),
      store,
    });

    const report = await support.run("Loop.", { as: "u_42" });

    expect(attempted).toBe(20);
    expect(report.status).toBe("stopped");
  });

  it("honors an explicit maxToolCalls", async () => {
    const store = memoryStore();
    let attempted = 0;
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "greedy",
        async *run(turn) {
          for (let index = 0; index < 5; index += 1) {
            const result = await turn.tools.call("invoices_list", {});
            if (result.status === "ok") attempted += 1;
          }
          yield { type: "text" as const, delta: "spent" };
        },
      }),
      tools: [readTool()],
      guard: permissive(),
      store,
    });

    const report = await support.run("Loop.", { as: "u_42", maxToolCalls: 2 });

    expect(attempted).toBe(2);
    expect(report.status).toBe("stopped");
  });

  it("stops on the caller's AbortSignal — the only way to stop a run", async () => {
    const controller = new AbortController();
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "slow",
        async *run(turn) {
          controller.abort();
          if (turn.signal.aborted) return;
          yield { type: "text" as const, delta: "should not arrive" };
        },
      }),
      store: memoryStore(),
    });

    const report = await support.run("Stop me.", { as: "u_42", signal: controller.signal });

    expect(report.status).toBe("stopped");
    expect(report.summary.trim()).not.toBe("");
  });

  it("continues a thread this subject owns, and refuses one they do not", async () => {
    const store = memoryStore();
    let seen = 0;
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "peek",
        async *run(turn) {
          seen = turn.messages.length;
          yield { type: "text" as const, delta: "ok" };
        },
      }),
      store,
    });

    const first = support.run("first", { as: "u_42" });
    await first;
    await support.run("second", { as: "u_42", threadId: first.threadId });
    expect(seen).toBe(3); // user, assistant, user

    await expect(support.run("sneak", { as: "u_99", threadId: first.threadId }))
      .rejects.toThrow(/No conversation thr_.* for this user/);
  });

  it("waits for a door still binding its port before the harness thinks", async () => {
    // `createSession` awaits `doorReady`; a run that did not would let a
    // `claudeCode()` box dial a door URL that is not there yet. A door that
    // fails to bind is the deterministic proof the wait happens at all: reached,
    // it is the run's own failure; ignored, the harness thinks anyway.
    let thought = false;
    const running = startRun({
      name: "support",
      store: memoryStore(),
      guard: permissive(),
      tools: { descriptors: async () => [], execute: async () => ({ status: "ok", output: {} }) },
      doorReady: Promise.reject(new Error("the door never bound")),
      harness: defineHarness({
        name: "waits",
        async *run() {
          thought = true;
          yield { type: "text" as const, delta: "ok" };
        },
      }),
    }, "go");

    await expect(running).rejects.toThrow("the door never bound");
    expect(thought).toBe(false);
  });

  it("a run nobody awaits cannot take the host process down", async () => {
    const store = memoryStore();
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "peek",
        async *run() {
          yield { type: "text" as const, delta: "ok" };
        },
      }),
      store,
    });
    const owned = support.run("first", { as: "u_42" });
    await owned;

    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      // Exactly what the doc invites: read the id, never await the report.
      const orphan = support.run("sneak", { as: "u_99", threadId: owned.threadId });
      expect(orphan.threadId).toBe(owned.threadId);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off("unhandledRejection", record);
    }

    expect(unhandled).toEqual([]);
  });

  it("leaves no guard listener behind, on the run that finished or the one that never started", async () => {
    let live = 0;
    const guard: VendoGuard = {
      ...permissive(),
      onApprovalRequested: () => {
        live += 1;
        return () => {
          live -= 1;
        };
      },
    };
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "peek",
        async *run() {
          yield { type: "text" as const, delta: "ok" };
        },
      }),
      guard,
      store: memoryStore(),
    });

    const owned = support.run("first", { as: "u_42" });
    await owned;
    expect(live).toBe(0);

    // A rejection a caller can repeat at will — every one used to leave a
    // callback in the guard's set forever.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(support.run("sneak", { as: "u_99", threadId: owned.threadId })).rejects.toThrow();
    }
    expect(live).toBe(0);
  });
});
