import type { ToolDescriptor } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_MISS_TOOL_NAME,
  DEFAULT_MAX_INITIAL_TOOLS,
  VENDO_TOOLS_SEARCH_TOOL_NAME,
  computeInitialLoadout,
  createAgent,
  type ToolSearchFn,
} from "./index.js";
import {
  boundRegistry,
  ctx,
  partOfType,
  readSse,
  scriptedModel,
  testGuard,
  textTurn,
  toolCallTurn,
  userMessage,
  type BoundRegistry,
  type TestToolImplementation,
} from "./test-helpers.js";

function descriptor(name: string, description: string, risk: ToolDescriptor["risk"] = "read"): ToolDescriptor {
  return { name, description, inputSchema: { type: "object" }, risk };
}

/** A stand-in search seam over a registry's descriptors. The REAL deterministic
 * ranker (ActionsRegistry.search / searchToolDescriptors) is unit-tested in
 * @vendoai/actions; the agent block depends on core only and cannot import it,
 * so these tests exercise the loadout + guard mechanics against a simple seam. */
function registrySearch(tools: BoundRegistry): ToolSearchFn {
  return async (query, options) => {
    const descriptors = await tools.descriptors();
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return descriptors
      .filter((d) => tokens.some((t) => d.name.toLowerCase().includes(t) || d.description.toLowerCase().includes(t)))
      .slice(0, options?.limit ?? 10)
      .map((d) => ({ name: d.name, description: d.description, risk: d.risk, score: 1 }));
  };
}

const missSurface = { format: "vendo/tools@1" as const, hash: `sha256:${"c".repeat(64)}` };

const impls: Record<string, TestToolImplementation> = {
  host_transactions_list: {
    descriptor: descriptor("host_transactions_list", "List transactions"),
    execute: async () => ({ items: [] }),
  },
  host_export_csv: {
    descriptor: descriptor("host_export_csv", "Export transactions to CSV", "write"),
    execute: async () => ({ url: "/download.csv" }),
  },
};

describe("computeInitialLoadout (loadout policy)", () => {
  const surface = [
    descriptor("vendo_apps_open", "Open an app"),
    descriptor("host_a_read", "read a"),
    descriptor("host_b_write", "write b", "write"),
    descriptor("host_c_wipe", "wipe c", "destructive"),
  ];
  const search: ToolSearchFn = async () => [];

  it("keeps the whole surface active when it fits the cap", () => {
    const loadout = computeInitialLoadout(surface, { search });
    expect(loadout).toEqual(new Set(["vendo_apps_open", "host_a_read", "host_b_write", "host_c_wipe"]));
  });

  it("honors an explicit curated loadout and always keeps vendo_* tools", () => {
    const loadout = computeInitialLoadout(surface, { search, loadout: ["host_b_write", "does_not_exist"] });
    expect(loadout).toEqual(new Set(["vendo_apps_open", "host_b_write"]));
  });

  it("applies a deterministic read-first bounded default when uncurated and large", () => {
    const big = [descriptor("vendo_apps_open", "Open an app")];
    for (let i = 0; i < 10; i += 1) big.push(descriptor(`host_w_${i}`, "w", "destructive"));
    for (let i = 0; i < 10; i += 1) big.push(descriptor(`host_r_${i}`, "r", "read"));
    const loadout = computeInitialLoadout(big, { search, maxInitialTools: 5 });
    // vendo_* always in; the 5 host slots go to read-risk tools first, by name.
    expect(loadout.has("vendo_apps_open")).toBe(true);
    const hostNames = [...loadout].filter((n) => n.startsWith("host_"));
    expect(hostNames).toHaveLength(5);
    expect(hostNames.every((n) => n.startsWith("host_r_"))).toBe(true);
  });

  it("defaults the cap to DEFAULT_MAX_INITIAL_TOOLS", () => {
    const big = [descriptor("vendo_apps_open", "Open an app")];
    for (let i = 0; i < DEFAULT_MAX_INITIAL_TOOLS + 50; i += 1) big.push(descriptor(`host_${i}`, "x"));
    const loadout = computeInitialLoadout(big, { search });
    expect([...loadout].filter((n) => n.startsWith("host_"))).toHaveLength(DEFAULT_MAX_INITIAL_TOOLS);
  });
});

describe("vendo_tools_search meta-tool", () => {
  it("loads a previously-unavailable tool and executes it through the guard-bound registry", async () => {
    const model = scriptedModel([
      toolCallTurn(VENDO_TOOLS_SEARCH_TOOL_NAME, { query: "export csv" }, "call_search"),
      toolCallTurn("host_export_csv", {}, "call_export"),
      textTurn("Exported.", "text_done"),
    ]);
    const guard = testGuard({ host_export_csv: "run" });
    const tools = boundRegistry(impls, guard);
    const search = vi.fn(registrySearch(tools));
    const agent = createAgent({ model, tools, guard, toolSearch: { search, loadout: [] } });

    await readSse(await agent.stream({
      threadId: "thr_load",
      message: userMessage("u1", "Export my transactions to CSV"),
      ctx: ctx(),
    }));

    expect(search).toHaveBeenCalledWith("export csv", undefined);
    // Gated at the start: the host tool is not offered until it is searched in.
    expect(model.toolNamesPerCall[0]).toContain(VENDO_TOOLS_SEARCH_TOOL_NAME);
    expect(model.toolNamesPerCall[0]).not.toContain("host_export_csv");
    // After search, the very next step offers — and the model calls — the tool.
    expect(model.toolNamesPerCall[1]).toContain("host_export_csv");
    expect(tools.invocations.host_export_csv).toBe(1);
    // Executed through the guard binding: an audit event was reported.
    expect(guard.events.some((e) => e.kind === "tool-call" && e.tool === "host_export_csv")).toBe(true);
  });

  it("still gates a searched-in WRITE tool through the guard (no unguarded path)", async () => {
    const model = scriptedModel([
      toolCallTurn(VENDO_TOOLS_SEARCH_TOOL_NAME, { query: "export csv" }, "call_search"),
      toolCallTurn("host_export_csv", {}, "call_export"),
      textTurn("unreached", "text_unreached"),
    ]);
    const guard = testGuard({ host_export_csv: "ask" });
    const tools = boundRegistry(impls, guard);
    const agent = createAgent({ model, tools, guard, toolSearch: { search: registrySearch(tools), loadout: [] } });

    const { parts } = await readSse(await agent.stream({
      threadId: "thr_gate",
      message: userMessage("u1", "Export my transactions to CSV"),
      ctx: ctx(),
    }));

    // The searched-in write tool was offered but its execution parked on approval.
    expect(model.toolNamesPerCall[1]).toContain("host_export_csv");
    expect(tools.invocations.host_export_csv).toBe(0);
    expect(guard.pending()).toHaveLength(1);
    const approval = parts.find((part) => part.type === "data-vendo-approval");
    expect(approval).toBeDefined();
  });

  it("persists loaded tools across turns within a thread", async () => {
    const model = scriptedModel([
      toolCallTurn(VENDO_TOOLS_SEARCH_TOOL_NAME, { query: "export csv" }, "call_search"),
      textTurn("Found it.", "text_first"),
      textTurn("Second turn.", "text_second"),
    ]);
    const guard = testGuard({});
    const tools = boundRegistry(impls, guard);
    const agent = createAgent({ model, tools, guard, toolSearch: { search: registrySearch(tools), loadout: [] } });

    await readSse(await agent.stream({
      threadId: "thr_persist",
      message: userMessage("u1", "Find a way to export CSV"),
      ctx: ctx(),
    }));
    await readSse(await agent.stream({
      threadId: "thr_persist",
      message: userMessage("u2", "now do it"),
      ctx: ctx(),
    }));

    // The second turn's FIRST model call already offers the tool loaded last turn.
    const secondTurnFirstCall = model.toolNamesPerCall[2]!;
    expect(secondTurnFirstCall).toContain("host_export_csv");
  });

  it("keeps the capability-miss meta-tool active when tool search is enabled (regression)", async () => {
    const misses: unknown[] = [];
    const model = scriptedModel([textTurn("Nothing to do.", "text_only")]);
    const guard = testGuard({});
    const tools = boundRegistry(impls, guard);
    const agent = createAgent({
      model,
      tools,
      guard,
      capabilityMiss: { hostId: "host_x", surface: Promise.resolve(missSurface), emit: (e) => misses.push(e) },
      toolSearch: { search: registrySearch(tools), loadout: [] },
    });

    await readSse(await agent.stream({ threadId: "thr_both", message: userMessage("u1", "hi"), ctx: ctx() }));

    // Both meta-tools stay offered even though host tools are gated by the loadout.
    expect(model.toolNamesPerCall[0]).toContain(VENDO_TOOLS_SEARCH_TOOL_NAME);
    expect(model.toolNamesPerCall[0]).toContain(CAPABILITY_MISS_TOOL_NAME);
    expect(model.toolNamesPerCall[0]).not.toContain("host_export_csv");
  });

  it("clears a thread's loaded tools on session eviction so a reused id starts fresh (regression)", async () => {
    const model = scriptedModel([
      toolCallTurn(VENDO_TOOLS_SEARCH_TOOL_NAME, { query: "export csv" }, "call_search"),
      textTurn("Found it.", "text_first"),
      textTurn("Fresh turn.", "text_second"),
    ]);
    const guard = testGuard({});
    const tools = boundRegistry(impls, guard);
    // No store → the in-memory (BYO) path, which is the one evictSubject reclaims.
    const agent = createAgent({ model, tools, guard, toolSearch: { search: registrySearch(tools), loadout: [] } });

    await readSse(await agent.stream({
      threadId: "thr_evict",
      message: userMessage("u1", "Find a way to export CSV"),
      ctx: ctx({ principal: { kind: "user", subject: "u_evict" } }),
    }));
    // Loaded within the first run.
    expect(model.toolNamesPerCall[1]).toContain("host_export_csv");

    agent.evictSubject("u_evict");

    await readSse(await agent.stream({
      threadId: "thr_evict",
      message: userMessage("u2", "now do it"),
      ctx: ctx({ principal: { kind: "user", subject: "u_evict" } }),
    }));
    // A reused thread id after eviction must NOT inherit the evicted loadout.
    expect(model.toolNamesPerCall[2]).not.toContain("host_export_csv");
  });

  it("bounds the initial loadout and searches in the needle on a 300+ tool host", async () => {
    const big: Record<string, TestToolImplementation> = {};
    for (let i = 0; i < 320; i += 1) {
      const name = `host_widget_${i}_get`;
      big[name] = { descriptor: descriptor(name, `Fetch widget ${i}`), execute: async () => ({ ok: true }) };
    }
    big.host_payouts_refund = {
      descriptor: descriptor("host_payouts_refund", "Refund a customer payout", "destructive"),
      execute: async () => ({ refunded: true }),
    };
    const model = scriptedModel([
      toolCallTurn(VENDO_TOOLS_SEARCH_TOOL_NAME, { query: "refund payout" }, "call_search"),
      toolCallTurn("host_payouts_refund", {}, "call_refund"),
      textTurn("done", "text_done"),
    ]);
    const guard = testGuard({ host_payouts_refund: "ask" });
    const tools = boundRegistry(big, guard);
    const agent = createAgent({ model, tools, guard, toolSearch: { search: registrySearch(tools) } });

    const { parts } = await readSse(await agent.stream({
      threadId: "thr_big",
      message: userMessage("u1", "Refund the last payout"),
      ctx: ctx(),
    }));

    // Bounded: the model is never handed all 321 tools; the destructive needle is
    // NOT in the initial loadout and only becomes callable after search.
    expect(model.toolNamesPerCall[0]!.length).toBeLessThanOrEqual(DEFAULT_MAX_INITIAL_TOOLS + 2);
    expect(model.toolNamesPerCall[0]).not.toContain("host_payouts_refund");
    expect(model.toolNamesPerCall[1]).toContain("host_payouts_refund");
    // The searched-in destructive tool is still guard-gated.
    expect(tools.invocations.host_payouts_refund).toBe(0);
    expect(parts.some((part) => part.type === "data-vendo-approval")).toBe(true);
  });
});
