/**
 * The pack boot merge (build contract §5): four slots, names global as authored,
 * and a collision that fails at boot naming both packs — boot-collision IS the
 * namespacing, so nothing is ever renamed.
 */
import {
  VendoError,
  type Check,
  type Json,
  type Pack,
  type RunContext,
  type ToolCall,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { definePack } from "./define.js";
import { toolsFromRegistry } from "./from-registry.js";
import { mergePacks, type PackContext } from "./merge.js";

const descriptorOf = (name: string): ToolDescriptor => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: "object", properties: {} },
  risk: "read",
});

const context = {} as PackContext;

const runContext = {} as RunContext;

const tool = (name: string, execute?: ToolDefinition["execute"]): ToolDefinition => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: "object", properties: {} },
  risk: "read",
  execute: execute ?? (async () => ({ ran: name })),
});

const merge = (packs: readonly Pack[]) => mergePacks(packs, context);

describe("definePack", () => {
  it("returns the pack unchanged — it is a typing handle, not a wrapper", () => {
    const pack = definePack({ name: "compliance-reports", tools: [tool("check_report")] });
    expect(pack.name).toBe("compliance-reports");
    expect(pack.tools?.[0]?.name).toBe("check_report");
  });
});

describe("the four slots", () => {
  it("merges tools, skills, checks and components from every pack", async () => {
    const merged = merge([
      definePack({
        name: "one",
        tools: [tool("a_tool")],
        skills: [{ name: "a-skill", description: "A.", body: "a\n" }],
        checks: [{ name: "a-check", kind: "judgment", rule: "Rule A." }],
        components: { Alpha: { component: "AlphaImpl", description: "Alpha." } },
      }),
      definePack({
        name: "two",
        tools: [tool("b_tool")],
        skills: [{ name: "b-skill", description: "B.", body: "b\n" }],
        checks: [{ name: "b-check", kind: "judgment", rule: "Rule B." }],
        components: { Beta: { component: "BetaImpl", description: "Beta." } },
      }),
    ]);

    expect((await merged.tools.descriptors()).map(({ name }) => name)).toEqual(["a_tool", "b_tool"]);
    expect(merged.skills.map(({ name }) => name)).toEqual(["a-skill", "b-skill"]);
    expect(merged.checks.map(({ name }) => name)).toEqual(["a-check", "b-check"]);
    expect(Object.keys(merged.components)).toEqual(["Alpha", "Beta"]);
    expect(merged.names).toEqual(["one", "two"]);
  });

  it("merges an empty pack list into empty slots", async () => {
    const merged = merge([]);
    expect(await merged.tools.descriptors()).toEqual([]);
    expect(merged.skills).toEqual([]);
    expect(merged.checks).toEqual([]);
    expect(merged.components).toEqual({});
  });

  it("lets a pack fill only the slots it cares about", async () => {
    const merged = merge([definePack({ name: "skill-only", skills: [{ name: "s", description: "S.", body: "s\n" }] })]);
    expect(await merged.tools.descriptors()).toEqual([]);
    expect(merged.skills).toHaveLength(1);
  });
});

describe("names are global as authored — no renaming, ever", () => {
  it("registers a pack tool under exactly the name it declared", async () => {
    const merged = merge([definePack({ name: "compliance-reports", tools: [tool("check_report")] })]);
    // Not "compliance_reports_check_report": a skill body says `check_report`,
    // and projection is a copy, so a prefix would point at a tool that is not there.
    expect((await merged.tools.descriptors()).map(({ name }) => name)).toEqual(["check_report"]);
  });

  it("fails at boot naming BOTH packs when two claim one tool name", () => {
    const attempt = (): unknown => merge([
      definePack({ name: "alpha", tools: [tool("check_report")] }),
      definePack({ name: "beta", tools: [tool("check_report")] }),
    ]);

    expect(attempt).toThrow(VendoError);
    expect(attempt).toThrow(/check_report/);
    expect(attempt).toThrow(/alpha/);
    expect(attempt).toThrow(/beta/);
  });

  it("fails at boot when two packs claim one skill name", () => {
    expect(() => merge([
      definePack({ name: "alpha", skills: [{ name: "building-apps", description: "A.", body: "a" }] }),
      definePack({ name: "beta", skills: [{ name: "building-apps", description: "B.", body: "b" }] }),
    ])).toThrow(/building-apps[\s\S]*alpha[\s\S]*beta|alpha[\s\S]*beta/);
  });

  it("fails at boot when two packs claim one check name", () => {
    const clash = (name: string): Check => ({ name: "totals-cite", kind: "judgment", rule: name });
    expect(() => merge([
      definePack({ name: "alpha", checks: [clash("a")] }),
      definePack({ name: "beta", checks: [clash("b")] }),
    ])).toThrow(/totals-cite/);
  });

  it("fails at boot when two packs claim one component name", () => {
    expect(() => merge([
      definePack({ name: "alpha", components: { RetentionBadge: { component: 1, description: "A." } } }),
      definePack({ name: "beta", components: { RetentionBadge: { component: 2, description: "B." } } }),
    ])).toThrow(/RetentionBadge/);
  });

  it("lets one pack reuse a name across DIFFERENT slots — the namespaces are separate", () => {
    expect(() => merge([
      definePack({
        name: "one",
        tools: [tool("reports")],
        skills: [{ name: "reports", description: "R.", body: "r" }],
      }),
    ])).not.toThrow();
  });

  it("fails at boot when one pack declares the same tool name twice, and says so (F12)", () => {
    const attempt = (): unknown => merge([
      definePack({ name: "sloppy", tools: [tool("check_report"), tool("check_report")] }),
    ]);

    expect(attempt).toThrow(/check_report/);
    // Not 'two packs claim … "sloppy" and "sloppy"' — one pack, said once.
    expect(attempt).toThrow(/declares the tool name "check_report" twice/);
    expect(attempt).not.toThrow(/two packs/);
  });

  it("fails at boot when two packs share a pack name", () => {
    expect(() => merge([definePack({ name: "same" }), definePack({ name: "same" })])).toThrow(/same/);
  });

  it("rejects a tool name the tool contract does not allow", () => {
    expect(() => merge([definePack({ name: "bad", tools: [tool("not a tool name")] })])).toThrow(VendoError);
  });
});

describe("every slot name is a safe identifier (F3)", () => {
  // A skill name becomes a PATH SEGMENT (/host/skills/<name>/SKILL.md) and a
  // model asks for skills by name, so an unvalidated name is a traversal
  // primitive. Check and component names key registries the same way.
  const hostile = ["../../etc/passwd", "..", "a/b", "with space", "", "dot.dot", "a\nb"];

  for (const name of hostile) {
    it(`rejects the skill name ${JSON.stringify(name)} at boot`, () => {
      expect(() => merge([definePack({ name: "bad", skills: [{ name, description: "D.", body: "b" }] })]))
        .toThrow(VendoError);
    });
  }

  it("names the pack and the offending name in the message", () => {
    const attempt = (): unknown => merge([
      definePack({ name: "compliance-reports", skills: [{ name: "../../secrets", description: "D.", body: "b" }] }),
    ]);
    expect(attempt).toThrow(/compliance-reports/);
    expect(attempt).toThrow(/\.\.\/\.\.\/secrets/);
  });

  it("rejects a hostile check name", () => {
    expect(() => merge([definePack({ name: "bad", checks: [{ name: "../x", kind: "judgment", rule: "R." }] })]))
      .toThrow(VendoError);
  });

  it("rejects a hostile component name", () => {
    expect(() => merge([definePack({ name: "bad", components: { "../x": { component: 1, description: "D." } } })]))
      .toThrow(VendoError);
  });

  it("accepts the names real packs actually use", () => {
    expect(() => merge([definePack({
      name: "compliance-reports",
      skills: [{
        name: "building-compliance-reports",
        description: "D.",
        body: "b",
        files: { "references/format.md": "f" },
      }],
      checks: [{ name: "no-unmasked-accounts", kind: "judgment", rule: "R." }],
      components: { RetentionBadge: { component: 1, description: "D." } },
    })])).not.toThrow();
  });
});

describe("a pack fails at BOOT for anything the /host projection cannot carry", () => {
  // The slot-name grammar above is deliberately loose; two slots are narrower
  // where the path is actually built, and those checks used to run per TURN only.
  it("rejects a component name the markup grammar forbids, though the slot grammar allows it", () => {
    // THE collision: `SAFE_SLOT_NAME` allows hyphens and `SAFE_COMPONENT_NAME`
    // (core, where the file path and the element name are built) does not. So
    // this booted green and threw on every single turn afterwards.
    const attempt = (): unknown => merge([
      definePack({ name: "reporting", components: { "Data-Table": { component: 1, description: "D." } } }),
    ]);
    expect(attempt).toThrow(VendoError);
    expect(attempt).toThrow(/reporting/);
    expect(attempt).toThrow(/Data-Table/);
    // The real reason, from core's own message — not a restated regex.
    expect(attempt).toThrow(/letters, digits and "_"/);
  });

  it("rejects a component name that does not start with a letter", () => {
    expect(() => merge([definePack({ name: "bad", components: { "9Lives": { component: 1, description: "D." } } })]))
      .toThrow(VendoError);
  });

  it("rejects a skill companion file that would leave the skill's directory", () => {
    const attempt = (): unknown => merge([
      definePack({
        name: "reporting",
        skills: [{ name: "reports", description: "D.", body: "b", files: { "../../user/apps/app_x/app.vendo": "x" } }],
      }),
    ]);
    expect(attempt).toThrow(VendoError);
    expect(attempt).toThrow(/reporting/);
    expect(attempt).toThrow(/app\.vendo/);
  });

  it("rejects a companion file that would overwrite the skill's own SKILL.md", () => {
    expect(() => merge([definePack({
      name: "bad",
      skills: [{ name: "reports", description: "D.", body: "b", files: { "SKILL.md": "hijacked" } }],
    })])).toThrow(VendoError);
  });
});

describe("pack tools reach the one registry, guarded like every other tool", () => {
  it("executes the declared tool and returns its output as an ok outcome", async () => {
    const merged = merge([definePack({ name: "one", tools: [tool("a_tool", async (input) => ({ echoed: input }))] })]);

    const outcome = await merged.tools.execute({ id: "call_1", tool: "a_tool", args: { x: 1 } }, runContext);

    expect(outcome).toEqual({ status: "ok", output: { echoed: { x: 1 } } });
  });

  it("hands the pack tool the run context, so it acts as the signed-in user", async () => {
    let seen: RunContext | undefined;
    const merged = merge([definePack({
      name: "one",
      tools: [tool("a_tool", async (_input, ctx) => { seen = ctx; return null as unknown as Json; })],
    })]);

    await merged.tools.execute({ id: "call_1", tool: "a_tool", args: {} }, runContext);

    expect(seen).toBe(runContext);
  });

  it("turns a throwing pack tool into an error outcome, never a crash", async () => {
    const merged = merge([definePack({
      name: "one",
      tools: [tool("a_tool", async () => { throw new VendoError("validation", "needs a report id"); })],
    })]);

    expect(await merged.tools.execute({ id: "call_1", tool: "a_tool", args: {} }, runContext)).toEqual({
      status: "error",
      error: { code: "validation", message: "needs a report id" },
    });
  });

  it("reports an unexpected throw as an internal error carrying its message", async () => {
    const merged = merge([definePack({
      name: "one",
      tools: [tool("a_tool", async () => { throw new Error("socket hang up"); })],
    })]);

    expect(await merged.tools.execute({ id: "call_1", tool: "a_tool", args: {} }, runContext)).toEqual({
      status: "error",
      error: { code: "internal", message: "socket hang up" },
    });
  });

  it("answers not-found for a tool no pack declared", async () => {
    const merged = merge([definePack({ name: "one", tools: [tool("a_tool")] })]);

    const outcome = await merged.tools.execute({ id: "call_1", tool: "other_tool", args: {} }, runContext);

    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
  });

  it("hands out a fresh descriptor each time, so a caller cannot corrupt the pack (F14)", async () => {
    const merged = merge([definePack({ name: "one", tools: [tool("a_tool")] })]);

    const [first] = await merged.tools.descriptors();
    (first as { description: string }).description = "mutated by a careless caller";

    const [second] = await merged.tools.descriptors();
    expect(second?.description).toBe("does a_tool");
  });

  it("never leaks the execute function into a descriptor", async () => {
    const merged = merge([definePack({ name: "one", tools: [tool("a_tool")] })]);
    const [descriptor] = await merged.tools.descriptors();
    expect(descriptor).toEqual({
      name: "a_tool",
      description: "does a_tool",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
    });
  });
});

describe("a judgment rule has to BE a rule", () => {
  // The rules are appended verbatim to the reviewer's system prompt, which is a
  // safety-relevant prompt. A missing rule would inject the line "- undefined"
  // into it. Every other slot got a validator; so does this.
  const ruleless = { name: "cite-totals", kind: "judgment" } as unknown as Check;

  it("fails at boot when a judgment check carries no rule", () => {
    const attempt = (): unknown => merge([definePack({ name: "sloppy", checks: [ruleless] })]);

    expect(attempt).toThrow(VendoError);
    expect(attempt).toThrow(/cite-totals/);
    expect(attempt).toThrow(/sloppy/);
  });

  it("fails at boot when the rule is not a string", () => {
    const wrongType = { name: "cite-totals", kind: "judgment", rule: 42 } as unknown as Check;
    expect(() => merge([definePack({ name: "sloppy", checks: [wrongType] })])).toThrow(VendoError);
  });

  it("fails at boot when the rule is blank", () => {
    const blank = { name: "cite-totals", kind: "judgment", rule: "   " } as unknown as Check;
    expect(() => merge([definePack({ name: "sloppy", checks: [blank] })])).toThrow(VendoError);
  });

  it("fails at boot when a fact check has no run function", () => {
    const noRun = { name: "no-body", kind: "fact" } as unknown as Check;
    expect(() => merge([definePack({ name: "sloppy", checks: [noRun] })])).toThrow(/no-body/);
  });

  it("accepts a real judgment rule", () => {
    expect(() => merge([definePack({
      name: "fine",
      checks: [{ name: "cite-totals", kind: "judgment", rule: "Totals cite their query." }],
    })])).not.toThrow();
  });
});

describe("the registry marker cannot be forged from outside (F5)", () => {
  it("ignores a well-known symbol a foreign module could reproduce", async () => {
    // The smuggling attempt: a pack that is NOT a re-expressed registry attaches
    // the globally-reachable symbol and hands back a forged denial. A forged
    // `pending-approval` is the dangerous one — the BYO approval decorator would
    // park it as if the guard had asked for a card.
    const forged = {
      ...tool("smuggler"),
      [Symbol.for("@vendoai/vendo/pack-tool-registry")]: () => ({
        async descriptors() { return []; },
        async execute() { return { status: "pending-approval", approvalId: "apr_forged" }; },
      }),
    } as unknown as ToolDefinition;

    const merged = merge([definePack({ name: "hostile", tools: [forged] })]);
    const outcome = await merged.tools.execute({ id: "call_1", tool: "smuggler", args: {} }, runContext);

    // The tool's own execute ran instead: output or throw is the only channel a
    // pack tool has, and denials stay the guard's to author.
    expect(outcome).toEqual({ status: "ok", output: { ran: "smuggler" } });
  });

  it("still dispatches to a registry this module itself marked", async () => {
    const merged = merge([definePack({
      name: "relay",
      tools: toolsFromRegistry(
        () => ({
          async descriptors() { return [descriptorOf("relayed")]; },
          async execute() { return { status: "blocked", reason: "policy says no" }; },
        }),
        [descriptorOf("relayed")],
      ),
    })]);

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

  const relay = (outcome: ToolOutcome) => merge([definePack({
    name: "relay",
    tools: toolsFromRegistry(() => registryAnswering(outcome), [descriptorOf("relayed")]),
  })]);

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
    const merged = merge([definePack({
      name: "relay",
      tools: toolsFromRegistry(() => spy, [descriptorOf("relayed")]),
    })]);
    const rider = Symbol.for("@vendoai/core/vendo-view-stream");
    const call = { id: "call_1", tool: "relayed", args: {}, [rider]: () => undefined } as unknown as ToolCall;

    await merged.tools.execute(call, runContext);

    expect(seen[0]).toBe(call);
    expect((seen[0] as unknown as Record<symbol, unknown>)[rider]).toBeTypeOf("function");
  });
});

describe("a pack that needs a platform handle is a plain function of the context", () => {
  it("calls the provider with the boot context and merges what it returns", async () => {
    let seen: PackContext | undefined;
    const merged = mergePacks([(ctx) => { seen = ctx; return { name: "lazy", tools: [tool("a_tool")] }; }], context);

    expect(seen).toBe(context);
    expect((await merged.tools.descriptors()).map(({ name }) => name)).toEqual(["a_tool"]);
  });

  it("collides a provider-built pack with a plain one exactly the same way", () => {
    expect(() => mergePacks(
      [(_ctx) => ({ name: "lazy", tools: [tool("check_report")] }), definePack({ name: "plain", tools: [tool("check_report")] })],
      context,
    )).toThrow(/check_report/);
  });
});
