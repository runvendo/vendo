import type { RiskLabel } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuard } from "../../src/guard.js";
import type { PolicyRule } from "../../src/types.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { alice, AUTOMATION_ID, awayContext, call, context, descriptor, FixtureTools, seedGrant } from "../fixtures/tools.js";

// INDEPENDENT SAFETY CHECK of 3cf5916e ("a tool call is decided once"). Each
// test below names a call the guard BEFORE that commit blocked/parked, and that
// the guard AFTER it executes — or an approval tap the commit spends that the
// previous code left unspent.

const write = descriptor("write");

afterEach(() => {
  vi.useRealTimers();
});

describe("ATTACK: the org-admin layer is not re-read at dispatch", () => {
  it("an org rule adopted between the preview and the dispatch no longer clamps the call", async () => {
    let orgRules: PolicyRule[] = [];
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "run" }] },
      orgPolicy: async () => orgRules,
    });
    const tools = new FixtureTools();
    const c = call(write.name, { value: 1 }, "call_org");

    await expect(guard.previewCheck!(c, write, context())).resolves.toMatchObject({ action: "run" });
    // The admin tightens the org layer while the call sits previewed.
    orgRules = [{ match: {}, action: "block", note: "org says no" }];

    await expect(guard.bind(tools).execute(c, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(0);
  });

  it("the previewed verdict has no age limit at read time — ten minutes later it still answers", async () => {
    let orgRules: PolicyRule[] = [];
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "run" }] },
      orgPolicy: async () => orgRules,
    });
    const tools = new FixtureTools();
    const c = call(write.name, { value: 1 }, "call_org_stale");

    await expect(guard.previewCheck!(c, write, context())).resolves.toMatchObject({ action: "run" });

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    orgRules = [{ match: {}, action: "block", note: "org says no" }];

    await expect(guard.bind(tools).execute(c, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(0);
  });
});

describe("ATTACK: the EFFECTIVE descriptor is remembered, so THE LAW's unattended gate reads a stale grade", () => {
  it("an unattended run executes a re-graded destructive tool off a preview taken while it read as a read", async () => {
    const store = createMemoryStore();
    // Declared `read`; the risk resolver answers `read` for the preview and
    // `destructive` for every pass after it (an app re-grade / catalog refresh
    // landing between the two).
    const tool = descriptor("read", { name: "host_regraded" });
    let resolutions = 0;
    const guard = createGuard({
      store,
      resolveRisk: async (): Promise<RiskLabel> => {
        resolutions += 1;
        return resolutions === 1 ? "read" : "destructive";
      },
    });
    // An away-capable standing grant hashed against the READ grade.
    await seedGrant(store, {
      descriptor: tool,
      automationId: AUTOMATION_ID,
      source: "automation",
    });
    const tools = new FixtureTools([tool]);
    const ctx = awayContext();
    const c = call(tool.name, { value: 1 }, "call_regrade");

    await expect(guard.previewCheck!(c, tool, ctx)).resolves.toMatchObject({ action: "run" });

    // Fresh, the dispatch would re-resolve to `destructive`: the grant's hash no
    // longer matches, nothing else authorizes it, and THE LAW withholds a
    // destructive tool from an unattended run. It must park, not run.
    await expect(guard.bind(tools).execute(c, ctx)).resolves.toMatchObject({
      status: "pending-approval",
    });
    expect(tools.executions).toHaveLength(0);
  });
});

describe("ATTACK: a freeze landing between the preview and the dispatch spends the human's single-use yes", () => {
  it("keeps the tap unspent when the frozen dispatch runs nothing", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "ask" }] },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const c = call(write.name, { value: 1 }, "call_frozen_tap");

    // Park, and let the person say yes.
    const parked = await guard.previewCheck!(c, write, context());
    if (parked.action !== "ask") throw new Error("expected the preview to park");
    await guard.approvals.decide(parked.approval.id, { approve: true }, alice);

    // The caller previews the same call again: the approved, unspent tap makes
    // it a "run", and that verdict is handed to the dispatch.
    await expect(guard.previewCheck!(c, write, context()))
      .resolves.toMatchObject({ action: "run", decidedBy: "grant" });

    // The kill switch lands before the dispatch reaches the tool.
    await guard.freeze("ops");
    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(0);

    // The freeze lifts. Nothing consumed the person's yes, so the call runs.
    await guard.unfreeze("ops");
    await expect(bound.execute(c, context())).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
  });
});

describe("ATTACK: the judge is not re-asked, so it never sees what the run did in between", () => {
  it("blocks the second of two previewed calls once the first one has landed on the trail", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      judge: {
        // The judge's whole point is that it reads `recent`: once this subject
        // has already written once in this run, the next write is refused.
        async decide({ recent }) {
          const wrote = recent.some((event) => event.kind === "tool-call" && event.tool === write.name);
          return wrote
            ? { action: "block", rationale: "one write per run is enough" }
            : { action: "run", rationale: "first write" };
        },
      },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const first = call(write.name, { value: 1 }, "call_judge_1");
    const second = call(write.name, { value: 2 }, "call_judge_2");

    // Both calls of one step are previewed before either is dispatched.
    await expect(guard.previewCheck!(first, write, context())).resolves.toMatchObject({ action: "run" });
    await expect(guard.previewCheck!(second, write, context())).resolves.toMatchObject({ action: "run" });

    await expect(bound.execute(first, context())).resolves.toMatchObject({ status: "ok" });
    await expect(bound.execute(second, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(1);
  });
});

describe("CONTROL: things the reuse must not have broken", () => {
  it("a yes taken back between the preview and the dispatch still parks the call", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "ask" }] },
    });
    const tools = new FixtureTools();
    const c = call(write.name, { value: 1 }, "call_taken_back");

    const parked = await guard.previewCheck!(c, write, context());
    if (parked.action !== "ask") throw new Error("expected the preview to park");
    await guard.approvals.decide(parked.approval.id, { approve: true }, alice);
    await expect(guard.previewCheck!(c, write, context()))
      .resolves.toMatchObject({ action: "run", decidedBy: "grant" });

    await guard.approvals.revoke(parked.approval.id, alice);

    await expect(guard.bind(tools).execute(c, context())).resolves.toMatchObject({
      status: "pending-approval",
    });
    expect(tools.executions).toHaveLength(0);
  });


  it("a dispatch whose presence, venue or app differs from the preview is decided fresh", async () => {
    for (const differs of [
      { presence: "away" as const },
      { venue: "app" as const },
      { appId: "app_other" },
      { sessionId: "session_other" },
    ]) {
      const judge = {
        decisions: 0,
        async decide(this: { decisions: number }) {
          this.decisions += 1;
          return { action: "run" as const, rationale: "counted" };
        },
      };
      const guard = createGuard({ store: createMemoryStore(), judge });
      const read = descriptor("read");
      const c = call(read.name, { value: 1 }, "call_pin");

      await guard.previewCheck!(c, read, context());
      await guard.bind(new FixtureTools()).execute(c, context(differs));
      // A key MISS is the whole point: the pipeline runs a second time.
      expect(judge.decisions, JSON.stringify(differs)).toBe(2);
    }
  });

  it("two dispatches racing one previewed verdict still execute the tool twice, each decided once", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: {}, action: "run" }] },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const c = call(write.name, { value: 1 }, "call_race");

    await guard.previewCheck!(c, write, context());
    const [a, b] = await Promise.all([bound.execute(c, context()), bound.execute(c, context())]);
    expect(a).toMatchObject({ status: "ok" });
    expect(b).toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(2);
  });

  it("a grant revoked between the preview and the dispatch still parks the call", async () => {
    const store = createMemoryStore();
    const tool = descriptor("destructive", { name: "host_revoked" });
    const grant = await seedGrant(store, { descriptor: tool });
    const guard = createGuard({ store });
    const tools = new FixtureTools([tool]);
    const c = call(tool.name, { value: 1 }, "call_revoked");

    await expect(guard.previewCheck!(c, tool, context())).resolves.toMatchObject({ action: "run" });
    await guard.grants.revoke(grant.id, alice);

    await expect(guard.bind(tools).execute(c, context())).resolves.toMatchObject({
      status: "pending-approval",
    });
    expect(tools.executions).toHaveLength(0);
  });
});
