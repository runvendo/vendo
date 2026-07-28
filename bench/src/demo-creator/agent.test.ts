import { describe, expect, it } from "vitest";
import { assertDisjointOwnership, buildClaudeArgs, effectiveExitCode, parseAgentOutput, type AgentJob } from "./agent.js";

/** The values a flag carries, up to the next `--option`. */
function valuesAfter(args: string[], flag: string): string[] {
  const rest = args.slice(args.indexOf(flag) + 1);
  const end = rest.findIndex((value) => value.startsWith("--"));
  return end === -1 ? rest : rest.slice(0, end);
}

function job(name: string, ownedRoots: string[]): AgentJob {
  return { name, prompt: `build ${name}`, ownedRoots, maxBudgetUsd: 5, timeoutMs: 60_000, model: "sonnet" };
}

describe("buildClaudeArgs", () => {
  it("gives a read-only agent nothing that can write", () => {
    const args = buildClaudeArgs({ prompt: "plan it", maxBudgetUsd: 3, model: "sonnet" }, { readOnly: true });
    expect(valuesAfter(args, "--allowedTools")).toEqual(["Read", "Glob", "Grep"]);
  });

  it("adds Write and Edit for a generating agent", () => {
    const args = buildClaudeArgs({ prompt: "build it", maxBudgetUsd: 3, model: "sonnet" });
    expect(valuesAfter(args, "--allowedTools")).toEqual(["Read", "Glob", "Grep", "Write", "Edit"]);
  });

  /** These agents run with `--permission-mode bypassPermissions`, so the tool
   * lists are the ONLY fence: a shell or a network fetch would let a generation
   * agent leave the demo folder entirely. */
  it("always disallows Bash, WebFetch, WebSearch and Task", () => {
    for (const readOnly of [true, false]) {
      const args = buildClaudeArgs({ prompt: "x", maxBudgetUsd: 3, model: "sonnet" }, { readOnly });
      expect(args).toContain("bypassPermissions");
      expect(valuesAfter(args, "--disallowedTools")).toEqual(expect.arrayContaining(["Bash", "WebFetch", "WebSearch", "Task"]));
      expect(valuesAfter(args, "--allowedTools")).not.toContain("Bash");
    }
  });

  it("threads the prompt, the model and the budget cap", () => {
    const args = buildClaudeArgs({ prompt: "clone the board", maxBudgetUsd: 2.5, model: "opus" });
    expect(valuesAfter(args, "-p")).toEqual(["clone the board"]);
    expect(valuesAfter(args, "--model")).toEqual(["opus"]);
    expect(valuesAfter(args, "--max-budget-usd")).toEqual(["2.5"]);
  });
});

describe("parseAgentOutput", () => {
  it("extracts result and cost from an --output-format json payload", () => {
    expect(parseAgentOutput(JSON.stringify({ result: "done", total_cost_usd: 1.23 })))
      .toEqual({ output: "done", costUsd: 1.23, isError: false });
  });

  it("reads is_error out of the payload", () => {
    expect(parseAgentOutput(JSON.stringify({ result: "budget exceeded", is_error: true })))
      .toEqual({ output: "budget exceeded", isError: true });
  });

  it("falls through with raw stdout when the CLI printed no JSON", () => {
    expect(parseAgentOutput("Error: claude: command not found")).toEqual({
      output: "Error: claude: command not found",
      isError: false,
    });
  });
});

describe("effectiveExitCode", () => {
  it("maps is_error onto a non-zero exit even when claude exited 0", () => {
    // The budget-exceeded case: the CLI reports the failure in the payload and
    // still exits 0, so trusting the process code would ship a demo whose
    // generation agent silently did nothing.
    expect(effectiveExitCode(0, true)).toBe(1);
  });

  it("keeps a clean run clean and a real non-zero exit intact", () => {
    expect(effectiveExitCode(0, false)).toBe(0);
    expect(effectiveExitCode(2, false)).toBe(2);
    expect(effectiveExitCode(null, false)).toBe(1);
  });
});

describe("assertDisjointOwnership", () => {
  it("passes genuinely disjoint roots", () => {
    expect(() => assertDisjointOwnership([job("domain", ["server", "openapi.json"]), job("screens", ["screens"])])).not.toThrow();
  });

  it("rejects two agents owning the same root", () => {
    expect(() => assertDisjointOwnership([job("domain", ["server"]), job("screens", ["server"])]))
      .toThrow(/redesign the split/);
  });

  it("rejects a root nested inside another agent's root", () => {
    expect(() => assertDisjointOwnership([job("domain", ["server"]), job("screens", ["server/routes.ts"])]))
      .toThrow(/redesign the split/);
  });

  it("names both agents and both roots so the split can be fixed", () => {
    const error = (() => {
      try {
        assertDisjointOwnership([job("domain", ["server"]), job("beats", ["server/seed.ts"])]);
        return undefined;
      } catch (thrown) {
        return thrown as Error;
      }
    })();
    expect(error?.message).toContain("domain");
    expect(error?.message).toContain("beats");
    expect(error?.message).toContain("server");
    expect(error?.message).toContain("server/seed.ts");
  });
});
