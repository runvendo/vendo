/**
 * What an UNATTENDED run owes its caller, proved against merged main by an
 * independent prove-walk: the budget bounds the run even when every call parks,
 * the brief carries the user the caller named, an aborted run does nothing at
 * all, and a guard that fails while parking is reported as a failure rather than
 * as "waiting on a person". Real embedded store, real guard, real runtime; only
 * the thinker is scripted (CLAUDE.md: test the SEAM).
 */
import type { Guard, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, threadStore } from "@vendoai/store";
import { describe, expect, it } from "vitest";
import { agent } from "../src/agent.js";
import { startRun } from "../src/away.js";
import { tool } from "../src/tools.js";

let stores = 0;
const memoryStore = () => createStore({ dataDir: `memory://agents-unattended-${stores++}` });

const readTool = () => tool({
  name: "invoices_list",
  description: "List invoices",
  risk: "read",
  inputSchema: { type: "object" },
  execute: () => ({ invoices: 2 }),
});

/** A harness that calls one tool `attempts` times and then speaks. */
const looper = (attempts: number) => defineHarness({
  name: "looper",
  async *run(turn) {
    for (let index = 0; index < attempts; index += 1) await turn.tools.call("invoices_list", {});
    yield { type: "text" as const, delta: "done" };
  },
});

describe("run() — the budget bounds a run whose calls PARK", () => {
  // The shipped guard parks every away call it cannot trace to an app-bound
  // grant, so in production every host tool call an unattended run makes is a
  // parked one — and a parked call was denied before the budget rail, which
  // meant the budget bounded nothing and a looping model minted one approval
  // card per attempt (25 cards against a budget of 20, reported `ok`).
  it("spends the budget on parked calls too, and stops rather than minting cards forever", async () => {
    const store = memoryStore();
    const support = agent({
      name: "support",
      harness: looper(5),
      tools: [readTool()],
      store,
    });

    const report = await support.run("Loop.", { as: "u_42", maxToolCalls: 2 });

    // Two cards for two attempts the budget allowed — never one per attempt.
    expect(report.refs.approvals).toHaveLength(2);
    expect(report.toolCalls.map(({ outcome }) => outcome))
      .toEqual(["pending-approval", "pending-approval", "error", "error", "error"]);
    expect(report.status).toBe("stopped");
  });
});

describe("run() — the brief", () => {
  const briefFor = async (options: Parameters<ReturnType<typeof agent>["run"]>[1]): Promise<string> => {
    let seen = "";
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "peek",
        async *run(turn) {
          seen = turn.system ?? "";
          yield { type: "text" as const, delta: "ok" };
        },
      }),
      store: memoryStore(),
    });
    await support.run("go", options);
    return seen;
  };

  // Documented as model-visible (`RunOptions.user`) and assembled by `session`,
  // but dropped on the way to the away assembler: the block never reached the
  // model on an unattended run.
  it("carries the user the caller named, as [User]", async () => {
    const brief = await briefFor({ as: "u_42", user: { name: "Dana", plan: "pro" } });

    expect(brief).toContain("[User]");
    expect(brief).toContain("name: Dana");
    expect(brief).toContain("acting for the user named below");
  });

  it("names no user when there is none — a dangling reference is a lie about the run", async () => {
    const brief = await briefFor({ as: "u_42" });

    expect(brief).toContain("You are an agent embedded in the host application.");
    expect(brief).not.toContain("the user named below");
  });
});

describe("run() — an already-aborted signal", () => {
  it("does no work at all: no thread, no harness, just the stop", async () => {
    const store = memoryStore();
    let thought = false;
    const support = agent({
      name: "support",
      harness: defineHarness({
        name: "eager",
        async *run() {
          thought = true;
          yield { type: "text" as const, delta: "should not arrive" };
        },
      }),
      store,
    });
    // The run itself opens the schema; opened here so the read below can answer
    // for a thread that was never written rather than for a store never touched.
    await store.ensureSchema();
    const controller = new AbortController();
    controller.abort();

    const running = support.run("Stop me.", { as: "u_42", signal: controller.signal });
    const report = await running;

    expect(report.status).toBe("stopped");
    expect(thought).toBe(false);
    expect(await threadStore(store).get({ kind: "user", subject: "u_42" }, running.threadId as never))
      .toBeNull();
  });
});

describe("run() — a guard that fails while parking", () => {
  const descriptor: ToolDescriptor = {
    name: "invoices_list",
    description: "List invoices",
    inputSchema: { type: "object" },
    risk: "read",
  };
  const registry: ToolRegistry = {
    descriptors: async () => [descriptor],
    execute: async () => ({ status: "ok", output: { invoices: 2 } }),
  };
  /** Fails closed the way the shipped preview does: it wants a person, and it
   *  minted nothing for anyone to answer. */
  const brokenGuard = (): Guard => ({
    check: async () => {
      throw new Error("the guard is down");
    },
    report: async () => {},
    directions: async () => [],
    onApprovalDecision: () => () => {},
    onApprovalRequested: () => () => {},
  });

  // "pending-approval" with `refs.approvals: []` tells the host to wait on a
  // person who has nothing to answer — the run is stuck, silently, forever.
  it("reports the failure, not a card nobody has", async () => {
    const report = await startRun({
      name: "support",
      store: memoryStore(),
      guard: brokenGuard(),
      tools: registry,
      harness: looper(1),
    }, "read the invoices", { as: "u_42" });

    expect(report.refs.approvals).toEqual([]);
    expect(report.toolCalls.map(({ call, outcome }) => [call.tool, outcome]))
      .toEqual([["invoices_list", "error"]]);
  });
});
