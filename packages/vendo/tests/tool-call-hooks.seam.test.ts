/**
 * The turn's TWO tool-call watchers, through the REAL composition.
 *
 * `agent_run`'s `toolCalls`/`tools` are counted by a hook composition puts on the
 * bridge (harness-turn.ts); the capability-miss detector's hook is added by the
 * harness runtime (harnesses/runtime.ts). They shared ONE `onCall` slot and the
 * runtime's assignment won, so a composed turn that really executed host tools
 * reported `{ toolCalls: 0, tools: [] }` — in every composed deployment, since
 * composition always configures capability miss.
 *
 * Only a real turn can show that. A unit test that calls `onCall` itself never
 * touches the assignment that discarded it, and a harness that mocks either
 * watcher lets the two agree forever. So: one composed turn, real host tools that
 * really run, both watchers read through their own production read path — the
 * usage sink for the count, and the reporter tool's `reported` latch for the miss
 * detector (it answers `false` only once the detector has already fired).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, ToolDescriptor, ToolRegistry, VendoUsageEvent } from "@vendoai/core";
import { setUsageSink } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  // A leaked sink is another suite's failure, not this one's.
  setUsageSink(undefined);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_hooks" };

const request = (path: string, body: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const descriptor = (name: string): ToolDescriptor => ({
  name,
  title: name,
  description: `The host's ${name}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  // `read` throughout: the guard runs a read silently, so what this file measures
  // is the watchers and never an approval card.
  risk: "read",
});

/**
 * Two REAL host tools with observable side effects: one that answers, and one
 * that is broken the same way twice — which is exactly what the capability-miss
 * detector watches `onCall` for.
 */
function hostTools(): { tools: ToolRegistry; executed: string[] } {
  const executed: string[] = [];
  return {
    executed,
    tools: {
      async descriptors() {
        return [descriptor("maple_invoices_list"), descriptor("maple_ledger_export")];
      },
      async execute(call) {
        executed.push(call.tool);
        if (call.tool === "maple_ledger_export") {
          return { status: "error", error: { code: "upstream", message: "the ledger is offline" } };
        }
        return { status: "ok", output: { invoices: [{ id: "inv_1" }] } };
      },
    },
  };
}

async function compose(harness: Parameters<typeof createVendo>[0]["harness"]): Promise<{
  vendo: Vendo;
  host: ReturnType<typeof hostTools>;
  runs: VendoUsageEvent[];
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-tool-hooks-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const host = hostTools();
  const vendo = createVendo({
    // Never reached: the harness below is scripted, so no provider is involved.
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    harness,
  });
  vendo.actions.add(host.tools);
  // AFTER createVendo: composition installs its own sink at boot (undefined
  // without a Cloud key), so an earlier install would simply be replaced.
  const runs: VendoUsageEvent[] = [];
  setUsageSink((event) => { if (event.name === "agent_run") runs.push(event); });
  return { vendo, host, runs };
}

describe("both tool-call watchers survive a composed turn", () => {
  it("counts every executed call AND still reports the capability miss", async () => {
    let latch: unknown;
    const { vendo, host, runs } = await compose(defineHarness({
      name: "scripted",
      async *run(turn) {
        await turn.tools.call("maple_invoices_list", {});
        // Twice, and the same tool: two failures in one turn is the detector's
        // `repeated-tool-failure` trigger, and it can only see them through the
        // `onCall` finisher.
        await turn.tools.call("maple_ledger_export", {});
        await turn.tools.call("maple_ledger_export", {});
        // The reporter answers `{ reported: false }` only when the detector has
        // ALREADY reported — so this is the miss rail's own read path saying its
        // hook ran, with nothing stubbed on either side.
        const outcome = await turn.tools.call("vendo_report_capability_miss", {
          kind: "no-matching-tool",
          toolsConsidered: ["maple_ledger_export"],
        });
        latch = outcome.status === "ok" ? outcome.output : outcome;
        yield { type: "text", delta: "done" };
      },
    }));

    const turn = await vendo.handler(request("/threads", {
      threadId: "thr_hooks", message: userMessage("m1", "export the ledger"),
    }));
    expect(await turn.text()).toContain("done");

    // The host tools really ran — not a mirror, not a stub.
    expect(host.executed).toEqual([
      "maple_invoices_list",
      "maple_ledger_export",
      "maple_ledger_export",
    ]);

    // Watcher one, read off the shipped usage sink. The reporter tool is
    // dispatched before the guarded-call path, so it is deliberately not counted.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      name: "agent_run",
      toolCalls: 3,
      tools: ["maple_invoices_list", "maple_ledger_export"],
      outcome: "ok",
    });

    // Watcher two, unchanged: the detector fired on the second failure, so the
    // reporter has nothing left to report.
    expect(latch).toEqual({ reported: false });
  });
});
