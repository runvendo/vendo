import { canonicalJson, sha256Hex } from "@vendoai/core";
import type { GuardDecision, RiskLabel, RunContext, ToolDescriptor } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuard } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { FixtureTools, alice, call, context, descriptor, seedGrant } from "./fixtures/tools.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("decision pipeline conformance", () => {
  const stages = ["critical", "scanner", "grant", "rule", "code", "judge", "default"] as const;
  const presences = ["present", "away"] as const;
  const risks: RiskLabel[] = ["read", "write", "destructive"];

  for (const stage of stages) {
    for (const presence of presences) {
      for (const risk of risks) {
        it(`${stage} decides ${presence} ${risk} calls at its pinned stage`, async () => {
          const store = createMemoryStore();
          const d = descriptor(risk, {
            name: `host_${stage}_${presence}_${risk}`,
            ...(stage === "critical" ? { critical: true } : {}),
          });
          const toolCall = call(d.name, { amount: 10 }, `call_${stage}_${presence}_${risk}`);
          const ctx = context({
            presence,
            ...(presence === "away" ? { venue: "automation", appId: "app_1" } : {}),
          });

          if (stage === "grant") {
            await seedGrant(store, {
              descriptor: d,
              ...(presence === "away" ? { appId: "app_1" } : {}),
            });
          }

          const guard = createGuard({
            store,
            ...(stage === "scanner"
              ? {
                  scanners: [
                    {
                      name: "input-deny",
                      on: "input" as const,
                      scan: async () => ({ verdict: "block" as const, findings: ["unsafe input"] }),
                    },
                  ],
                }
              : {}),
            ...(stage === "rule"
              ? { policy: { rules: [{ match: { tool: d.name }, action: "block" as const }] } }
              : {}),
            ...(stage === "code"
              ? {
                  policy: {
                    code: (): GuardDecision => ({
                      action: "block",
                      reason: "blocked by code",
                      decidedBy: "rule",
                    }),
                  },
                }
              : {}),
            ...(stage === "judge"
              ? {
                  judge: {
                    decide: async () => ({ action: "block" as const, rationale: "judge denied" }),
                  },
                }
              : {}),
          });

          const decision = await guard.check(toolCall, d, ctx);
          const expected = {
            critical: { action: "ask", decidedBy: "critical" },
            scanner: { action: "block", decidedBy: "scanner" },
            grant: { action: "run", decidedBy: "grant" },
            rule: { action: "block", decidedBy: "rule" },
            code: { action: "block", decidedBy: "rule" },
            judge: { action: "block", decidedBy: "judge" },
            // 05 §6: away holds only app-bound grants — the default posture
            // auto-runs present calls but parks away ones.
            default:
              presence === "away"
                ? { action: "ask", decidedBy: "default" }
                : { action: "run", decidedBy: "default" },
          }[stage];
          expect(decision).toMatchObject(expected);
        });
      }
    }
  }

  it.each([
    {
      name: "standing tool scope",
      grant: {},
      ctx: {},
      args: { amount: 10 },
      matches: true,
    },
    {
      name: "exact scope with canonical input hash",
      grant: {
        scope: {
          kind: "exact" as const,
          inputHash: `sha256:${sha256Hex(canonicalJson({ amount: 10 }))}`,
          inputPreview: "host_write {\"amount\":10}",
        },
      },
      ctx: {},
      args: { amount: 10 },
      matches: true,
    },
    {
      name: "exact scope rejects different input",
      grant: {
        scope: {
          kind: "exact" as const,
          inputHash: `sha256:${sha256Hex(canonicalJson({ amount: 9 }))}`,
          inputPreview: "host_write {\"amount\":9}",
        },
      },
      ctx: {},
      args: { amount: 10 },
      matches: false,
    },
    {
      name: "constrained scope resolves JSON pointers and every operator",
      grant: {
        scope: {
          kind: "constrained" as const,
          constraints: [
            { path: "/amount", op: "lte" as const, value: 10 },
            { path: "/amount", op: "gte" as const, value: 5 },
            { path: "/currency", op: "eq" as const, value: "USD" },
            { path: "/memo", op: "matches" as const, value: "^invoice-[0-9]+$" },
            { path: "/a~1b/~0key", op: "eq" as const, value: true },
          ],
        },
      },
      ctx: {},
      args: { amount: 7, currency: "USD", memo: "invoice-42", "a/b": { "~key": true } },
      matches: true,
    },
    {
      name: "constrained scope rejects unresolved and type-mismatched values",
      grant: {
        scope: {
          kind: "constrained" as const,
          constraints: [
            { path: "/missing", op: "eq" as const, value: 1 },
            { path: "/amount", op: "lte" as const, value: 10 },
          ],
        },
      },
      ctx: {},
      args: { amount: "7" },
      matches: false,
    },
    {
      name: "constrained matches rejects oversized patterns (ReDoS bound)",
      grant: {
        scope: {
          kind: "constrained" as const,
          constraints: [{ path: "/memo", op: "matches" as const, value: `^${"(a+)+".repeat(60)}$` }],
        },
      },
      ctx: {},
      args: { memo: "aaaa" },
      matches: false,
    },
    {
      name: "constrained matches rejects nested-quantifier patterns even within length bounds (ReDoS)",
      grant: {
        scope: {
          kind: "constrained" as const,
          constraints: [{ path: "/memo", op: "matches" as const, value: "^(a+)+$" }],
        },
      },
      ctx: {},
      args: { memo: `${"a".repeat(64)}b` },
      matches: false,
    },
    {
      name: "constrained matches rejects backreference patterns (ReDoS)",
      grant: {
        scope: {
          kind: "constrained" as const,
          constraints: [{ path: "/memo", op: "matches" as const, value: "^(a*)b\\1$" }],
        },
      },
      ctx: {},
      args: { memo: "ab" },
      matches: false,
    },
    {
      name: "constrained matches rejects oversized input values (ReDoS bound)",
      grant: {
        scope: {
          kind: "constrained" as const,
          constraints: [{ path: "/memo", op: "matches" as const, value: "^a+$" }],
        },
      },
      ctx: {},
      args: { memo: "a".repeat(5000) },
      matches: false,
    },
    {
      name: "session duration matches sessionId",
      grant: { duration: "session" as const, contextKey: "session_1" },
      ctx: { sessionId: "session_1" },
      args: {},
      matches: true,
    },
    {
      name: "session duration rejects another session",
      grant: { duration: "session" as const, contextKey: "session_other" },
      ctx: { sessionId: "session_1" },
      args: {},
      matches: false,
    },
    {
      name: "task duration matches trigger runId",
      grant: { duration: "task" as const, contextKey: "run_1" },
      ctx: { trigger: { runId: "run_1", kind: "schedule" as const } },
      args: {},
      matches: true,
    },
    {
      name: "task duration falls back to sessionId without trigger",
      grant: { duration: "task" as const, contextKey: "session_1" },
      ctx: {},
      args: {},
      matches: true,
    },
    {
      name: "away requires an app-bound matching grant",
      grant: { appId: "app_1" },
      ctx: { presence: "away" as const, venue: "automation" as const, appId: "app_1" },
      args: {},
      matches: true,
    },
    {
      name: "away rejects an unbound chat grant",
      grant: {},
      ctx: { presence: "away" as const, venue: "automation" as const, appId: "app_1" },
      args: {},
      matches: false,
    },
    {
      name: "present rejects a grant bound to another app",
      grant: { appId: "app_other" },
      ctx: { appId: "app_1", venue: "app" as const },
      args: {},
      matches: false,
    },
    {
      name: "descriptor drift lapses the grant",
      grant: { descriptorHash: "sha256:stale" },
      ctx: {},
      args: {},
      matches: false,
    },
    {
      name: "revoked grant cannot match",
      grant: { revokedAt: "2026-01-01T00:00:00.000Z" },
      ctx: {},
      args: {},
      matches: false,
    },
    {
      name: "expired grant cannot match",
      grant: { expiresAt: "2025-12-31T23:59:59.000Z" },
      ctx: {},
      args: {},
      matches: false,
    },
  ])("grant matching: $name", async ({ grant, ctx: ctxOverrides, args, matches }) => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = createMemoryStore();
    const d = descriptor("write");
    await seedGrant(store, { descriptor: d, ...grant });
    const guard = createGuard({
      store,
      policy: { rules: [{ match: { tool: d.name }, action: "block" }] },
    });
    const decision = await guard.check(call(d.name, args), d, context(ctxOverrides as Partial<RunContext>));
    expect(decision).toMatchObject(
      matches
        ? { action: "run", decidedBy: "grant" }
        : { action: "block", decidedBy: "rule" },
    );
  });

  it.each([
    ["critical beats grant", "critical"],
    ["scanner block beats grant", "scanner"],
    ["grant beats rule", "grant"],
    ["rule beats code", "rule"],
    ["code beats judge", "code"],
    ["judge beats default", "judge"],
  ] as const)("stage precedence: %s", async (_name, winner) => {
    const store = createMemoryStore();
    const d = descriptor("read", { critical: winner === "critical" });
    if (["critical", "scanner", "grant"].includes(winner)) await seedGrant(store, { descriptor: d });
    const guard = createGuard({
      store,
      scanners:
        winner === "scanner"
          ? [{ name: "deny", on: "input", scan: async () => ({ verdict: "block", findings: ["deny"] }) }]
          : [],
      policy: {
        ...(winner === "grant" ? { rules: [{ match: {}, action: "block" as const }] } : {}),
        ...(winner === "rule"
          ? {
              rules: [{ match: {}, action: "block" as const }],
              code: (): GuardDecision => ({ action: "run", decidedBy: "default" }),
            }
          : {}),
        ...(winner === "code"
          ? {
              code: (): GuardDecision => ({ action: "block", reason: "code", decidedBy: "rule" }),
            }
          : {}),
      },
      judge: {
        decide: async () => ({ action: winner === "judge" ? "block" : "run", rationale: "judge" }),
      },
    });
    const decision = await guard.check(call(d.name), d, context());
    expect(decision.decidedBy).toBe(winner === "code" ? "rule" : winner);
    if (winner === "code") {
      expect(decision).toMatchObject({ action: "block", reason: "code" });
    }
  });

  it("call-rate breaker only downgrades runs and clears after the sliding window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const d = descriptor("read");
    const guard = createGuard({ store: createMemoryStore(), breakers: { maxCallsPerMinute: 1 } });

    await expect(guard.check(call(d.name, {}, "call_1"), d, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "default",
    });
    await expect(guard.check(call(d.name, {}, "call_2"), d, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "breaker",
    });

    const blockedGuard = createGuard({
      store: createMemoryStore(),
      breakers: { maxCallsPerMinute: 0 },
      policy: { rules: [{ match: {}, action: "block" }] },
    });
    await expect(blockedGuard.check(call(d.name), d, context())).resolves.toMatchObject({
      action: "block",
      decidedBy: "rule",
    });
    const critical = descriptor("write", { name: "host_critical", critical: true });
    await expect(blockedGuard.check(call(critical.name), critical, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "critical",
    });

    vi.setSystemTime(new Date("2026-01-01T00:01:00.001Z"));
    await expect(guard.check(call(d.name, {}, "call_3"), d, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "default",
    });
  });

  it("sweeps idle breaker state: a run idle over an hour restarts its write budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const guard = createGuard({
      store: createMemoryStore(),
      breakers: { maxWritesPerRun: 1, maxCallsPerMinute: 100 },
    });
    const write = descriptor("write");
    const run = context({ trigger: { runId: "run_sweep", kind: "schedule" } });

    await expect(guard.check(call(write.name, {}, "w1"), write, run)).resolves.toMatchObject({ action: "run" });
    await expect(guard.check(call(write.name, {}, "w2"), write, run)).resolves.toMatchObject({
      action: "ask",
      decidedBy: "breaker",
    });

    // 61 idle minutes later the counter has been swept (documented bounded-memory trade-off).
    vi.setSystemTime(new Date("2026-01-01T01:01:00.001Z"));
    await expect(guard.check(call(write.name, {}, "w3"), write, run)).resolves.toMatchObject({ action: "run" });
  });

  it("write breaker counts write and destructive runs per trigger run key", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      breakers: { maxWritesPerRun: 1, maxCallsPerMinute: 100 },
    });
    const read = descriptor("read");
    const write = descriptor("write");
    const destructive = descriptor("destructive");
    const runOne = context({ trigger: { runId: "run_1", kind: "schedule" } });
    const runTwo = context({ trigger: { runId: "run_2", kind: "schedule" } });

    await expect(guard.check(call(read.name, {}, "read_1"), read, runOne)).resolves.toMatchObject({
      action: "run",
    });
    await expect(guard.check(call(write.name, {}, "write_1"), write, runOne)).resolves.toMatchObject({
      action: "run",
    });
    await expect(
      guard.check(call(destructive.name, {}, "destroy_1"), destructive, runOne),
    ).resolves.toMatchObject({ action: "ask", decidedBy: "breaker" });
    await expect(guard.check(call(write.name, {}, "write_2"), write, runTwo)).resolves.toMatchObject({
      action: "run",
    });
  });
});

describe("away authority (05 §6)", () => {
  const awayCtx = () => context({ presence: "away", venue: "automation", appId: "app_1" });

  it("parks an unconfigured away call instead of default-running it", async () => {
    const store = createMemoryStore();
    const d = descriptor("write");
    const guard = createGuard({ store });
    await expect(guard.check(call(d.name, {}), d, awayCtx())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "default",
    });
    // The same unconfigured guard still auto-runs the present call.
    await expect(guard.check(call(d.name, {}), d, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "default",
    });
  });

  it("parks an away call even when a rule says run", async () => {
    const store = createMemoryStore();
    const d = descriptor("read");
    const guard = createGuard({
      store,
      policy: { rules: [{ match: { risk: "read" }, action: "run" }] },
    });
    await expect(guard.check(call(d.name, {}), d, awayCtx())).resolves.toMatchObject({ action: "ask" });
  });

  it("attaches the authorizing grant as ctx.grant for executors (04 §4 ActAs seam)", async () => {
    const store = createMemoryStore();
    const d = descriptor("write");
    const seeded = await seedGrant(store, { descriptor: d, appId: "app_1" });
    const guard = createGuard({ store });
    const tools = new FixtureTools([d]);
    const bound = guard.bind(tools);

    await expect(bound.execute(call(d.name, {}), awayCtx())).resolves.toMatchObject({ status: "ok" });
    const execution = tools.executions[0];
    if (!execution) throw new Error("expected the granted call to execute");
    expect((execution.ctx as { grant?: { id: string } }).grant).toMatchObject({
      id: seeded.id,
      tool: d.name,
      appId: "app_1",
    });
  });
});
