import { VENDO_BASH_TOOL, VENDO_POLICY_FORMAT, VendoError } from "@vendoai/core";
import type { GuardDecision } from "@vendoai/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuard } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { alice, call, context, descriptor, FixtureTools } from "./fixtures/tools.js";

const originalCwd = process.cwd();
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vendo-guard-policy-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function policyFile(document: unknown): Promise<string> {
  const directory = await temporaryDirectory();
  const file = join(directory, "policy.json");
  await writeFile(file, JSON.stringify(document), "utf8");
  return file;
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("policy files, rules, directions, and code", () => {
  it("uses first-match-wins with anchored globs and exact venue/presence fields", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: {
        rules: [
          { match: { tool: "gmail_*", presence: "present" }, action: "run" },
          { match: { tool: "gmail_*" }, action: "block", note: "email blocked" },
          { match: { venue: "mcp" }, action: "block", note: "mcp blocked" },
          { match: { presence: "away" }, action: "ask" },
        ],
      },
    });
    const gmail = descriptor("write", { name: "gmail_send" });
    const lookalike = descriptor("write", { name: "xgmail_send" });

    await expect(guard.check(call(gmail.name), gmail, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "rule",
    });
    await expect(guard.check(call(gmail.name), gmail, context({ presence: "away" }))).resolves.toEqual({
      action: "block",
      reason: "email blocked",
      decidedBy: "rule",
    });
    await expect(guard.check(call(lookalike.name), lookalike, context({ venue: "mcp" }))).resolves.toEqual({
      action: "block",
      reason: "mcp blocked",
      decidedBy: "rule",
    });
    await expect(
      guard.check(call(lookalike.name), lookalike, context({ venue: "automation", presence: "away" })),
    ).resolves.toMatchObject({ action: "ask", decidedBy: "rule" });
  });

  it("loads a valid file lazily and resolves file directions", async () => {
    const file = await policyFile({
      format: VENDO_POLICY_FORMAT,
      directions: ["Refer tax questions to an accountant."],
      rules: [{ match: { risk: "destructive" }, action: "block", note: "file says no" }],
    });
    const guard = createGuard({ store: createMemoryStore(), policy: { file } });
    const destructive = descriptor("destructive");

    await expect(guard.directions(context())).resolves.toEqual(["Refer tax questions to an accountant."]);
    await expect(guard.check(call(destructive.name), destructive, context())).resolves.toEqual({
      action: "block",
      reason: "file says no",
      decidedBy: "rule",
    });
  });

  it("does not merge inline rules or directions with file values", async () => {
    const file = await policyFile({
      format: VENDO_POLICY_FORMAT,
      directions: ["file direction"],
      rules: [{ match: { tool: "host_read" }, action: "block" }],
    });
    const guard = createGuard({
      store: createMemoryStore(),
      policy: {
        file,
        directions: ["inline direction"],
        rules: [{ match: { tool: "host_read" }, action: "run" }],
      },
    });
    const read = descriptor("read");

    await expect(guard.directions(context())).resolves.toEqual(["inline direction"]);
    await expect(guard.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "rule",
    });
  });

  it("fails loud with validation errors for malformed or explicitly missing files", async () => {
    const malformed = await policyFile({ format: "vendo/policy@999", rules: "not-an-array" });
    const malformedGuard = createGuard({ store: createMemoryStore(), policy: { file: malformed } });
    await expect(malformedGuard.check(call(), descriptor(), context())).rejects.toMatchObject({
      code: "validation",
    });

    const directory = await temporaryDirectory();
    const missingGuard = createGuard({
      store: createMemoryStore(),
      policy: { file: join(directory, "does-not-exist.json") },
    });
    await expect(missingGuard.directions(context())).rejects.toMatchObject({ code: "validation" });
  });

  it("silently treats a missing default file as absent but never loads one without policy config", async () => {
    const directory = await temporaryDirectory();
    process.chdir(directory);
    const read = descriptor("read");
    const defaultFileGuard = createGuard({ store: createMemoryStore(), policy: {} });
    await expect(defaultFileGuard.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "default",
    });
    await expect(defaultFileGuard.directions(context())).resolves.toEqual([]);

    const noPolicyGuard = createGuard({ store: createMemoryStore() });
    await expect(noPolicyGuard.check(call(read.name), read, context())).resolves.toMatchObject({ action: "run" });
  });

  it("uses inline rules and directions without loading a configured file", async () => {
    // A malformed file that inline config makes irrelevant must never abort:
    // inline wins with no merge, so the file is not even read.
    const malformed = await policyFile({ format: "vendo/policy@999", rules: "nope" });
    const guard = createGuard({
      store: createMemoryStore(),
      policy: {
        file: malformed,
        rules: [{ match: { tool: "host_read" }, action: "block", note: "inline wins" }],
        directions: ["inline only"],
      },
    });
    const read = descriptor("read");
    await expect(guard.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "block",
      decidedBy: "rule",
    });
    await expect(guard.directions(context())).resolves.toEqual(["inline only"]);
  });

  it("lets code decide or pass through and fails closed when code throws", async () => {
    const read = descriptor("read");
    const decided = createGuard({
      store: createMemoryStore(),
      policy: {
        code: (): GuardDecision => ({ action: "block", reason: "code denied", decidedBy: "rule" }),
      },
    });
    await expect(decided.check(call(read.name), read, context())).resolves.toEqual({
      action: "block",
      reason: "code denied",
      decidedBy: "rule",
    });

    const passed = createGuard({
      store: createMemoryStore(),
      policy: { code: () => undefined },
      judge: { decide: async () => ({ action: "run", rationale: "judge fallback" }) },
    });
    await expect(passed.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "judge",
    });

    const threw = createGuard({
      store: createMemoryStore(),
      policy: {
        code: () => {
          throw new Error("policy bug");
        },
      },
    });
    await expect(threw.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "rule",
    });
  });

  it("resolves contextual risk before policy rules without weakening unrelated writes", async () => {
    const apps = new Map([
      ["app_tree", { ui: "tree" as const }],
      ["app_bundle", { ui: "bundle" as const }],
    ]);
    // ONE tool now, so the shape of the CALL is what says whether this is a
    // change to an existing app: `app` present is the edit path, absent is the
    // create path, and only the first has an app whose ui decides the class.
    const resolveRisk = vi.fn(async (toolCall: ReturnType<typeof call>) => {
      if (toolCall.tool !== "vendo_make") return undefined;
      const args = toolCall.args as { app?: string; request?: string };
      if (args.app === undefined) return undefined;
      const app = apps.get(args.app);
      if (app?.ui !== "tree" || typeof args.request !== "string") return "write" as const;
      return args.request === "Make the heading blue" ? "read" as const : "write" as const;
    });
    const guard = createGuard({
      store: createMemoryStore(),
      resolveRisk,
      policy: {
        rules: [
          { match: { risk: "write" }, action: "ask" },
          { match: { risk: "read" }, action: "run" },
        ],
      },
    });
    const make = descriptor("read", { name: "vendo_make" });
    const hostWrite = descriptor("write", { name: "host_accounts_update" });
    const egress = descriptor("write", { name: "external_http_post" });

    await expect(guard.check(call(make.name, { request: "Build a dashboard" }), make, context()))
      .resolves.toMatchObject({ action: "run", decidedBy: "rule" });
    await expect(guard.check(call(make.name, {
      app: "app_tree",
      request: "Make the heading blue",
    }), make, context())).resolves.toMatchObject({ action: "run", decidedBy: "rule" });
    await expect(guard.check(call(make.name, {
      app: "app_tree",
      request: "Persist this to the database",
    }), make, context())).resolves.toMatchObject({
      action: "ask",
      approval: { descriptor: { risk: "write" } },
    });
    await expect(guard.check(call(make.name, {
      app: "app_bundle",
      request: "Change the heading",
    }), make, context())).resolves.toMatchObject({ action: "ask" });
    await expect(guard.check(call(hostWrite.name), hostWrite, context())).resolves.toMatchObject({ action: "ask" });
    await expect(guard.check(call(egress.name), egress, context())).resolves.toMatchObject({ action: "ask" });
    expect(resolveRisk).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "vendo_make" }),
      expect.objectContaining({ risk: "read" }),
      expect.objectContaining({ principal: expect.any(Object) }),
    );
  });

  it("uses contextual risk for write-breaker accounting", async () => {
    const make = descriptor("read", { name: "vendo_make" });
    const resolveRisk = vi.fn(async (toolCall: ReturnType<typeof call>) => {
      const args = toolCall.args as { request?: string };
      return args.request === "Make the heading blue" ? "read" as const : "write" as const;
    });
    const guard = createGuard({
      store: createMemoryStore(),
      resolveRisk,
      breakers: { maxWritesPerRun: 1, maxCallsPerMinute: 100 },
      policy: { rules: [{ match: {}, action: "run" }] },
    });
    const run = context({ trigger: { runId: "run_contextual_risk", kind: "schedule" } });

    await expect(guard.check(call(make.name, {
      app: "app_tree",
      request: "Make the heading blue",
    }, "tree_1"), make, run)).resolves.toMatchObject({ action: "run" });
    await expect(guard.check(call(make.name, {
      app: "app_tree",
      request: "Persist this to the database",
    }, "server_1"), make, run)).resolves.toMatchObject({ action: "run" });
    // A second read-class tree edit must not consume the one-write budget.
    await expect(guard.check(call(make.name, {
      app: "app_tree",
      request: "Make the heading blue",
    }, "tree_2"), make, run)).resolves.toMatchObject({ action: "run" });
    // The second server edit is still write-class and must trip the breaker.
    await expect(guard.check(call(make.name, {
      app: "app_tree",
      request: "Persist this to the database",
    }, "server_2"), make, run)).resolves.toMatchObject({
      action: "ask",
      decidedBy: "breaker",
      approval: { descriptor: { risk: "write" } },
    });
    expect(resolveRisk).toHaveBeenCalledTimes(4);
  });

  it("expands named presets to rules before evaluation (00-overview decision 8)", async () => {
    const read = descriptor("read");
    const write = descriptor("write");
    const destructive = descriptor("destructive");

    const cautious = createGuard({ store: createMemoryStore(), policy: "cautious" });
    await expect(cautious.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "rule",
    });
    await expect(cautious.check(call(write.name), write, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "rule",
    });
    await expect(cautious.check(call(destructive.name), destructive, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "rule",
    });

    const readonly = createGuard({ store: createMemoryStore(), policy: "readonly" });
    await expect(readonly.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "rule",
    });
    await expect(readonly.check(call(write.name), write, context())).resolves.toMatchObject({
      action: "block",
      decidedBy: "rule",
    });
    await expect(readonly.check(call(destructive.name), destructive, context())).resolves.toMatchObject({
      action: "block",
      decidedBy: "rule",
    });

    const autopilot = createGuard({ store: createMemoryStore(), policy: "autopilot" });
    await expect(autopilot.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "rule",
    });
    await expect(autopilot.check(call(write.name), write, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "rule",
    });
    await expect(autopilot.check(call(destructive.name), destructive, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "rule",
    });
  });

  it("still fully audits an autopilot-run call, attributed to the rule (not left unconfigured)", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store, policy: "autopilot" });
    const destructive = descriptor("destructive");
    const bound = guard.bind(new FixtureTools([destructive]));

    const outcome = await bound.execute(call(destructive.name), context());
    expect(outcome).toMatchObject({ status: "ok" });

    const { events } = await guard.audit.query({ principal: alice });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "tool-call",
      tool: destructive.name,
      outcome: "ok",
      decidedBy: "rule",
    });
  });

  it("reports autopilot as an explicitly configured posture, not unconfigured", () => {
    const unconfigured = createGuard({ store: createMemoryStore() });
    expect(unconfigured.status()).toEqual({ posture: "unconfigured" });

    const autopilot = createGuard({ store: createMemoryStore(), policy: "autopilot" });
    expect(autopilot.status()).toEqual({ posture: "rules" });

    const cautious = createGuard({ store: createMemoryStore(), policy: "cautious" });
    expect(cautious.status()).toEqual({ posture: "rules" });

    const readonly = createGuard({ store: createMemoryStore(), policy: "readonly" });
    expect(readonly.status()).toEqual({ posture: "rules" });
  });

  it("fails loud at compose time for an unknown policy preset name, naming the valid presets", () => {
    const create = (): unknown => createGuard({ store: createMemoryStore(), policy: "yolo" as never });
    expect(create).toThrow(VendoError);
    let caught: unknown;
    try {
      create();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VendoError);
    expect((caught as VendoError).code).toBe("validation");
    expect((caught as VendoError).message).toContain("yolo");
    expect((caught as VendoError).message).toContain("cautious");
    expect((caught as VendoError).message).toContain("readonly");
    expect((caught as VendoError).message).toContain("autopilot");
  });

  it("keeps the descriptor's conservative risk when contextual resolution fails", async () => {
    // A write-class app tool, because the fallback is only visible on one: a
    // resolver that throws must leave the static risk standing, which for a
    // write means the call still asks.
    const edit = descriptor("write", { name: "vendo_apps_data_put" });
    const policy = { rules: [
      { match: { risk: "write" as const }, action: "ask" as const },
      { match: { risk: "read" as const }, action: "run" as const },
    ] };
    const threw = createGuard({
      store: createMemoryStore(),
      resolveRisk: async () => { throw new Error("app lookup failed"); },
      policy,
    });
    const invalid = createGuard({
      store: createMemoryStore(),
      resolveRisk: async () => "not-a-risk" as never,
      policy,
    });

    await expect(threw.check(call(edit.name), edit, context())).resolves.toMatchObject({ action: "ask" });
    await expect(invalid.check(call(edit.name), edit, context())).resolves.toMatchObject({ action: "ask" });
  });
});

describe("the shell raises no approval card, and keeps everything its write grade buys", () => {
  const shell = descriptor("write", { name: VENDO_BASH_TOOL });
  const shellCall = (id = "call_1"): ReturnType<typeof call> =>
    call(VENDO_BASH_TOOL, { command: "wc -l files/ledger.csv" }, id);

  it("runs a bash call instead of asking, under the default policy", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: "cautious" });

    await expect(guard.check(shellCall(), shell, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "rule",
    });
  });

  it("still asks for another write-graded tool — the exemption is not a hole in the write rule", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: "cautious" });
    const write = descriptor("write");

    await expect(guard.check(call(write.name), write, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "rule",
    });
  });

  it("lets a host put the prompt back with their own rule", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: { rules: [{ match: { tool: VENDO_BASH_TOOL }, action: "ask" }] },
    });

    await expect(guard.check(shellCall(), shell, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "rule",
    });
  });

  it("lands an audit row for every bash call, prompt or no prompt", async () => {
    const store = createMemoryStore();
    const guard = createGuard({ store, policy: "cautious" });
    const tools = new FixtureTools([shell]);
    const bound = guard.bind(tools);

    await expect(bound.execute(shellCall("call_1"), context())).resolves.toMatchObject({ status: "ok" });
    await expect(bound.execute(shellCall("call_2"), context())).resolves.toMatchObject({ status: "ok" });

    const { events } = await guard.audit.query({ principal: alice });
    expect(events.filter((event) => event.kind === "tool-call" && event.tool === VENDO_BASH_TOOL))
      .toMatchObject([
        { risk: "write", outcome: "ok", decidedBy: "rule" },
        { risk: "write", outcome: "ok", decidedBy: "rule" },
      ]);
  });

  it("still stops a bash call at the kill switch", async () => {
    const guard = createGuard({ store: createMemoryStore(), policy: "cautious" });
    const tools = new FixtureTools([shell]);
    const bound = guard.bind(tools);

    await guard.freeze("ops_yousef");

    await expect(bound.execute(shellCall(), context())).resolves.toMatchObject({
      status: "blocked",
      reason: "vendo is frozen — nothing runs until it is unfrozen",
    });
    expect(tools.executions).toHaveLength(0);
  });
});
