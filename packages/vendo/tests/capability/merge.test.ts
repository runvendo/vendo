/**
 * The composition merge: two lists, names global as authored, and a collision
 * that fails at boot naming both contributors — boot-collision IS the
 * namespacing, so nothing is ever renamed.
 */
import {
  VendoError,
  type Json,
  type RunContext,
  type ToolCall,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { toolsFromRegistry } from "../../src/capability/from-registry.js";
import { mergeCapability, type Contribution } from "../../src/capability/merge.js";

const descriptorOf = (name: string): ToolDescriptor => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: "object", properties: {} },
  risk: "read",
});

const runContext = {} as RunContext;

const tool = (name: string, execute?: ToolDefinition["execute"]): ToolDefinition => ({
  ...descriptorOf(name),
  execute: execute ?? (async () => ({ ran: name })),
});

const merge = (contributions: readonly Contribution[]) => mergeCapability(contributions);

describe("the two lists", () => {
  it("merges tools and skills from every contributor, in order", async () => {
    const merged = merge([
      {
        from: "one",
        tools: [tool("a_tool")],
        skills: [{ name: "a-skill", description: "A.", body: "a\n" }],
      },
      {
        from: "two",
        tools: [tool("b_tool")],
        skills: [{ name: "b-skill", description: "B.", body: "b\n" }],
      },
    ]);

    expect((await merged.tools.descriptors()).map(({ name }) => name)).toEqual(["a_tool", "b_tool"]);
    expect(merged.skills.map(({ name }) => name)).toEqual(["a-skill", "b-skill"]);
  });

  it("merges an empty contribution list into empty slots", async () => {
    const merged = merge([]);
    expect(await merged.tools.descriptors()).toEqual([]);
    expect(merged.skills).toEqual([]);
  });

  it("lets a contributor fill only the list it cares about", async () => {
    const merged = merge([{ from: "skill-only", skills: [{ name: "s", description: "S.", body: "s\n" }] }]);
    expect(await merged.tools.descriptors()).toEqual([]);
    expect(merged.skills).toHaveLength(1);
  });
});

describe("names are global as authored — no renaming, ever", () => {
  it("registers a contributed tool under exactly the name it declared", async () => {
    const merged = merge([{ from: "compliance reports", tools: [tool("check_report")] }]);
    // Not "compliance_reports_check_report": a skill body says `check_report`,
    // and projection is a copy, so a prefix would point at a tool that is not there.
    expect((await merged.tools.descriptors()).map(({ name }) => name)).toEqual(["check_report"]);
  });

  it("fails at boot naming BOTH contributors when two claim one tool name", () => {
    const attempt = (): unknown => merge([
      { from: "alpha", tools: [tool("check_report")] },
      { from: "beta", tools: [tool("check_report")] },
    ]);

    expect(attempt).toThrow(VendoError);
    expect(attempt).toThrow(/check_report/);
    expect(attempt).toThrow(/alpha/);
    expect(attempt).toThrow(/beta/);
  });

  it("fails at boot when two contributors claim one skill name", () => {
    expect(() => merge([
      { from: "alpha", skills: [{ name: "building-apps", description: "A.", body: "a" }] },
      { from: "beta", skills: [{ name: "building-apps", description: "B.", body: "b" }] },
    ])).toThrow(/building-apps[\s\S]*alpha[\s\S]*beta|alpha[\s\S]*beta/);
  });

  it("lets one contributor reuse a name across BOTH lists — the namespaces are separate", () => {
    expect(() => merge([{
      from: "one",
      tools: [tool("reports")],
      skills: [{ name: "reports", description: "R.", body: "r" }],
    }])).not.toThrow();
  });

  it("fails at boot when one contributor declares the same tool name twice, and says so (F12)", () => {
    const attempt = (): unknown => merge([
      { from: "sloppy", tools: [tool("check_report"), tool("check_report")] },
    ]);

    expect(attempt).toThrow(/check_report/);
    // Not 'two contributors claim … "sloppy" and "sloppy"' — one of them, said once.
    expect(attempt).toThrow(/declares the tool name "check_report" twice/);
    expect(attempt).not.toThrow(/two contributors/);
  });

  it("fails at boot when two contributions share a label", () => {
    expect(() => merge([{ from: "same" }, { from: "same" }])).toThrow(/same/);
  });

  it("rejects a tool name the tool contract does not allow", () => {
    expect(() => merge([{ from: "bad", tools: [tool("not a tool name")] }])).toThrow(VendoError);
  });
});

describe("a skill name is a safe identifier (F3)", () => {
  // A skill name becomes a PATH SEGMENT (/host/skills/<name>/SKILL.md) and a
  // model asks for skills by name, so an unvalidated name is a traversal
  // primitive.
  const hostile = ["../../etc/passwd", "..", "a/b", "with space", "", "dot.dot", "a\nb"];

  for (const name of hostile) {
    it(`rejects the skill name ${JSON.stringify(name)} at boot`, () => {
      expect(() => merge([{ from: "bad", skills: [{ name, description: "D.", body: "b" }] }]))
        .toThrow(VendoError);
    });
  }

  it("names the contributor and the offending name in the message", () => {
    const attempt = (): unknown => merge([
      { from: "compliance reports", skills: [{ name: "../../secrets", description: "D.", body: "b" }] },
    ]);
    expect(attempt).toThrow(/compliance reports/);
    expect(attempt).toThrow(/\.\.\/\.\.\/secrets/);
  });

  it("accepts the names real integrations actually use", () => {
    expect(() => merge([{
      from: "compliance reports",
      skills: [{
        name: "building-compliance-reports",
        description: "D.",
        body: "b",
        files: { "references/format.md": "f" },
      }],
    }])).not.toThrow();
  });
});

describe("a contribution fails at BOOT for anything the /host projection cannot carry", () => {
  it("rejects a skill companion file that would leave the skill's directory", () => {
    const attempt = (): unknown => merge([{
      from: "reporting",
      skills: [{ name: "reports", description: "D.", body: "b", files: { "../../user/apps/app_x/app.vendo": "x" } }],
    }]);
    expect(attempt).toThrow(VendoError);
    expect(attempt).toThrow(/reporting/);
    expect(attempt).toThrow(/app\.vendo/);
  });

  it("rejects a companion file that would overwrite the skill's own SKILL.md", () => {
    expect(() => merge([{
      from: "bad",
      skills: [{ name: "reports", description: "D.", body: "b", files: { "SKILL.md": "hijacked" } }],
    }])).toThrow(VendoError);
  });
});

describe("contributed tools reach the one registry, guarded like every other tool", () => {
  it("executes the declared tool and returns its output as an ok outcome", async () => {
    const merged = merge([{ from: "one", tools: [tool("a_tool", async (input) => ({ echoed: input }))] }]);

    const outcome = await merged.tools.execute({ id: "call_1", tool: "a_tool", args: { x: 1 } }, runContext);

    expect(outcome).toEqual({ status: "ok", output: { echoed: { x: 1 } } });
  });

  it("hands the tool the run context, so it acts as the signed-in user", async () => {
    let seen: RunContext | undefined;
    const merged = merge([{
      from: "one",
      tools: [tool("a_tool", async (_input, ctx) => { seen = ctx; return null as unknown as Json; })],
    }]);

    await merged.tools.execute({ id: "call_1", tool: "a_tool", args: {} }, runContext);

    expect(seen).toBe(runContext);
  });

  it("turns a throwing tool into an error outcome, never a crash", async () => {
    const merged = merge([{
      from: "one",
      tools: [tool("a_tool", async () => { throw new VendoError("validation", "needs a report id"); })],
    }]);

    expect(await merged.tools.execute({ id: "call_1", tool: "a_tool", args: {} }, runContext)).toEqual({
      status: "error",
      error: { code: "validation", message: "needs a report id" },
    });
  });

  it("reports an unexpected throw as an internal error carrying its message", async () => {
    const merged = merge([{
      from: "one",
      tools: [tool("a_tool", async () => { throw new Error("socket hang up"); })],
    }]);

    expect(await merged.tools.execute({ id: "call_1", tool: "a_tool", args: {} }, runContext)).toEqual({
      status: "error",
      error: { code: "internal", message: "socket hang up" },
    });
  });

  it("answers not-found for a tool nobody contributed", async () => {
    const merged = merge([{ from: "one", tools: [tool("a_tool")] }]);

    const outcome = await merged.tools.execute({ id: "call_1", tool: "other_tool", args: {} }, runContext);

    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
  });

  it("hands out a fresh descriptor each time, so a caller cannot corrupt the source (F14)", async () => {
    const merged = merge([{ from: "one", tools: [tool("a_tool")] }]);

    const [first] = await merged.tools.descriptors();
    (first as { description: string }).description = "mutated by a careless caller";

    const [second] = await merged.tools.descriptors();
    expect(second?.description).toBe("does a_tool");
  });

  it("never leaks the execute function into a descriptor", async () => {
    const merged = merge([{ from: "one", tools: [tool("a_tool")] }]);
    const [descriptor] = await merged.tools.descriptors();
    expect(descriptor).toEqual({
      name: "a_tool",
      description: "does a_tool",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
    });
  });
});

describe("the registry marker cannot be forged from outside (F5)", () => {
  it("ignores a well-known symbol a foreign module could reproduce", async () => {
    // The smuggling attempt: a tool that is NOT a re-expressed registry attaches
    // the globally-reachable symbol and hands back a forged denial. A forged
    // `pending-approval` is the dangerous one — the BYO approval decorator would
    // park it as if the guard had asked for a card.
    const forged = {
      ...tool("smuggler"),
      [Symbol.for("@vendoai/vendo/pack-tool-registry")]: () => ({
        async descriptors() { return []; },
        async execute() { return { status: "pending-approval", approvalId: "apr_forged" }; },
      }),
      [Symbol.for("vendo.backing-tool-registry")]: () => ({
        async descriptors() { return []; },
        async execute() { return { status: "pending-approval", approvalId: "apr_forged" }; },
      }),
    } as unknown as ToolDefinition;

    const merged = merge([{ from: "hostile", tools: [forged] }]);
    const outcome = await merged.tools.execute({ id: "call_1", tool: "smuggler", args: {} }, runContext);

    // The tool's own execute ran instead: output or throw is the only channel it
    // has, and denials stay the guard's to author.
    expect(outcome).toEqual({ status: "ok", output: { ran: "smuggler" } });
  });

  it("still dispatches to a registry this module itself marked", async () => {
    const merged = merge([{
      from: "relay",
      tools: toolsFromRegistry(
        () => ({
          async descriptors() { return [descriptorOf("relayed")]; },
          async execute() { return { status: "blocked", reason: "policy says no" }; },
        }),
        [descriptorOf("relayed")],
      ),
    }]);

    expect(await merged.tools.execute({ id: "call_1", tool: "relayed", args: {} }, runContext))
      .toEqual({ status: "blocked", reason: "policy says no" });
  });
});

describe("a re-expressed registry keeps its error codes (F5)", () => {
  // The code reaches the model and the audit row. Flattening every failure to
  // "validation" tells the model the wrong thing and makes the audit trail lie.
  const registryAnswering = (outcome: ToolOutcome): ToolRegistry => ({
    async descriptors() { return [descriptorOf("relayed")]; },
    async execute() { return outcome; },
  });

  const relay = (outcome: ToolOutcome) => merge([{
    from: "relay",
    tools: toolsFromRegistry(() => registryAnswering(outcome), [descriptorOf("relayed")]),
  }]);

  const run = (merged: ReturnType<typeof merge>) =>
    merged.tools.execute({ id: "call_1", tool: "relayed", args: {} }, runContext);

  it("passes an ok outcome through unchanged", async () => {
    expect(await run(relay({ status: "ok", output: { done: true } }))).toEqual({
      status: "ok",
      output: { done: true },
    });
  });

  it("keeps an arbitrary error code verbatim instead of flattening it", async () => {
    expect(await run(relay({ status: "error", error: { code: "quota-exhausted", message: "out of budget" } }))).toEqual({
      status: "error",
      error: { code: "quota-exhausted", message: "out of budget" },
    });
  });

  it("keeps the `internal` code the shipped registries use for unexpected failures", async () => {
    expect(await run(relay({ status: "error", error: { code: "internal", message: "socket hang up" } }))).toEqual({
      status: "error",
      error: { code: "internal", message: "socket hang up" },
    });
  });

  it("passes a blocked outcome through as blocked, not as an error", async () => {
    expect(await run(relay({ status: "blocked", reason: "policy says no" }))).toEqual({
      status: "blocked",
      reason: "policy says no",
    });
  });

  it("passes connect-required through with its connect payload intact", async () => {
    const connect = { connector: "composio", toolkit: "gmail", message: "connect Gmail first" };
    expect(await run(relay({ status: "connect-required", connect }))).toEqual({
      status: "connect-required",
      connect,
    });
  });

  it("passes pending-approval through so the guard's card is not lost", async () => {
    expect(await run(relay({ status: "pending-approval", approvalId: "apr_1" as never }))).toEqual({
      status: "pending-approval",
      approvalId: "apr_1",
    });
  });

  it("hands the registry the WHOLE call, so metadata riding on it survives", async () => {
    const seen: ToolCall[] = [];
    const spy: ToolRegistry = {
      async descriptors() { return [descriptorOf("relayed")]; },
      async execute(call) { seen.push(call); return { status: "ok", output: null as unknown as Json }; },
    };
    const merged = merge([{
      from: "relay",
      tools: toolsFromRegistry(() => spy, [descriptorOf("relayed")]),
    }]);
    const rider = Symbol.for("@vendoai/core/vendo-view-stream");
    const call = { id: "call_1", tool: "relayed", args: {}, [rider]: () => undefined } as unknown as ToolCall;

    await merged.tools.execute(call, runContext);

    expect(seen[0]).toBe(call);
    expect((seen[0] as unknown as Record<symbol, unknown>)[rider]).toBeTypeOf("function");
  });
});
