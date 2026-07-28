import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDisjointOwnership,
  buildClaudeArgs,
  buildSandboxSettings,
  effectiveExitCode,
  parseAgentOutput,
  type AgentJob,
} from "./agent.js";

/** The values a flag carries, up to the next `--option`. */
function valuesAfter(args: string[], flag: string): string[] {
  const rest = args.slice(args.indexOf(flag) + 1);
  const end = rest.findIndex((value) => value.startsWith("--"));
  return end === -1 ? rest : rest.slice(0, end);
}

function job(name: string, ownedRoots: string[]): AgentJob {
  return { name, prompt: `build ${name}`, ownedRoots, maxBudgetUsd: 5, timeoutMs: 60_000, model: "sonnet" };
}

const demoRoot = path.join("/repo", "demos", "acme");
const sandbox = { writeRoot: demoRoot, readRoot: "/repo" };

describe("buildClaudeArgs", () => {
  it("gives a read-only agent nothing that can write", () => {
    const args = buildClaudeArgs({ prompt: "plan it", maxBudgetUsd: 3, model: "sonnet" }, { readOnly: true, sandbox });
    expect(valuesAfter(args, "--allowedTools")).toEqual(["Read", "Glob", "Grep"]);
  });

  // Scoped, never bare: probed against claude 2.1.220, a bare `Write` in
  // --allowedTools allows Write at any path on the filesystem — the scope in the
  // tool rule is what refuses an escape and records it in permission_denials.
  it("gives a generating agent Write and Edit scoped to its demo folder only", () => {
    const args = buildClaudeArgs({ prompt: "build it", maxBudgetUsd: 3, model: "sonnet" }, { sandbox });
    expect(valuesAfter(args, "--allowedTools")).toEqual([
      "Read", "Glob", "Grep", `Write(/${demoRoot}/**)`, `Edit(/${demoRoot}/**)`,
    ]);
    expect(valuesAfter(args, "--allowedTools")).not.toContain("Write");
    expect(valuesAfter(args, "--allowedTools")).not.toContain("Edit");
  });

  // Every build prompt sends the agent to demos/_example first — one directory
  // above its own — so the read scope is the checkout, not the folder.
  it("adds the checkout as a readable directory", () => {
    const args = buildClaudeArgs({ prompt: "build it", maxBudgetUsd: 3, model: "sonnet" }, { sandbox });
    expect(valuesAfter(args, "--add-dir")).toEqual(["/repo"]);
  });

  it("always disallows Bash, WebFetch, WebSearch and Task", () => {
    for (const readOnly of [true, false]) {
      const args = buildClaudeArgs({ prompt: "x", maxBudgetUsd: 3, model: "sonnet" }, { readOnly, sandbox });
      expect(valuesAfter(args, "--disallowedTools")).toEqual(expect.arrayContaining(["Bash", "WebFetch", "WebSearch", "Task"]));
      expect(valuesAfter(args, "--allowedTools")).not.toContain("Bash");
    }
  });

  // The whole point of finding 1: with bypassPermissions the CLI evaluates NO
  // permission rule at all, so the only thing standing between a generation
  // agent and the shared multi-tenant host was the model choosing to refuse.
  // A live probe wrote outside the demo folder with `permission_denials: []`.
  it("never runs an agent with permissions bypassed", () => {
    for (const readOnly of [true, false]) {
      const args = buildClaudeArgs({ prompt: "x", maxBudgetUsd: 3, model: "sonnet" }, { readOnly, sandbox });
      expect(args).not.toContain("bypassPermissions");
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("--allow-dangerously-skip-permissions");
      // `manual` keeps the permission layer on. Headless has nobody to prompt,
      // so anything the rules do not allow is denied — and the scoped Write rule
      // means the demo folder still needs no prompt.
      expect(valuesAfter(args, "--permission-mode")).toEqual(["manual"]);
    }
  });

  // The residual half of finding 4: the HOST was already harness-denied, but
  // which of the three parallel agents owns which file inside the demo folder was
  // still prompt text only ("YOUR FILE LIST"). Two agents that both decide to
  // touch screens/index.tsx race, and the loser's work vanishes silently — the
  // exact failure assertDisjointOwnership exists to make impossible in the SPLIT,
  // left possible at runtime.
  it("scopes Write and Edit to the agent's own roots, not the whole demo folder", () => {
    const owned = { ...sandbox, ownedRoots: ["server", "openapi.json"] };
    const tools = valuesAfter(buildClaudeArgs({ prompt: "x", maxBudgetUsd: 3, model: "sonnet" }, { sandbox: owned }), "--allowedTools");
    for (const tool of ["Write", "Edit"]) {
      // A file root and a directory root both need the exact path AND the subtree
      // form, since neither exists yet when the rules are written.
      expect(tools).toContain(`${tool}(/${path.join(demoRoot, "server")})`);
      expect(tools).toContain(`${tool}(/${path.join(demoRoot, "server")}/**)`);
      expect(tools).toContain(`${tool}(/${path.join(demoRoot, "openapi.json")})`);
      // …and crucially NOT the whole demo folder, which is another agent's turf.
      expect(tools).not.toContain(`${tool}(/${demoRoot}/**)`);
      // A root this agent does not own stays unwritable.
      expect(tools.some((rule) => rule.startsWith(`${tool}(`) && rule.includes(path.join(demoRoot, "screens")))).toBe(false);
    }
  });

  // Without a declared split there is nothing to narrow to, and the demo folder
  // remains the boundary — demo:fix's single agent owns the whole folder.
  it("falls back to the demo folder when the agent declares no roots", () => {
    const tools = valuesAfter(buildClaudeArgs({ prompt: "x", maxBudgetUsd: 3, model: "sonnet" }, { sandbox }), "--allowedTools");
    expect(tools).toContain(`Write(/${demoRoot}/**)`);
  });

  it("loads only its own settings file, never the operator's machine settings", () => {
    const args = buildClaudeArgs({ prompt: "x", maxBudgetUsd: 3, model: "sonnet" }, { sandbox });
    expect(valuesAfter(args, "--setting-sources")).toEqual([""]);
    const settings = JSON.parse(valuesAfter(args, "--settings")[0] ?? "{}") as Record<string, unknown>;
    expect(settings).toHaveProperty("permissions");
  });

  it("threads the prompt, the model and the budget cap", () => {
    const args = buildClaudeArgs({ prompt: "clone the board", maxBudgetUsd: 2.5, model: "opus" }, { sandbox });
    expect(valuesAfter(args, "-p")).toEqual(["clone the board"]);
    expect(valuesAfter(args, "--model")).toEqual(["opus"]);
    expect(valuesAfter(args, "--max-budget-usd")).toEqual(["2.5"]);
  });
});

describe("buildSandboxSettings", () => {
  const settings = (): {
    permissions: { allow: string[]; deny: string[]; defaultMode?: string; additionalDirectories?: string[] };
  } => JSON.parse(buildSandboxSettings(sandbox)) as {
    permissions: { allow: string[]; deny: string[]; defaultMode?: string; additionalDirectories?: string[] };
  };

  // Deny outranks allow and defaultMode, so the paths the whole host shares are
  // spelled out rather than left to "outside the working directory" alone.
  it("denies writing the host, whatever the working directory is", () => {
    const { deny } = settings().permissions;
    for (const tool of ["Write", "Edit"]) {
      expect(deny).toContain(`${tool}(/${path.join("/repo", "host")}/**)`);
    }
  });

  // A blanket deny over demos/** would also deny the ONE folder this agent
  // exists to write (deny outranks allow), so sibling demos are held by the
  // working-directory confinement and the host fence, not by a rule that would
  // break the run.
  it("never denies the demo folder it is generating", () => {
    const { deny } = settings().permissions;
    expect(deny.every((rule) => !rule.endsWith(`${demoRoot}/**)`))).toBe(true);
  });

  // The contract already calls these fenced ("NEVER edit theme.json, BRIEF.md,
  // brand/ or RESEARCH/") — until now only in the prompt, which is a request.
  it("denies the brand evidence the pipeline wrote from real evidence", () => {
    const { deny } = settings().permissions;
    for (const fenced of ["theme.json", "BRIEF.md", "brand", "RESEARCH"]) {
      expect(deny.some((rule) => rule.includes(path.join(demoRoot, fenced)))).toBe(true);
    }
  });

  // The build prompts tell every agent to read demos/_example first, which is
  // OUTSIDE its working directory: a sandbox that blocked that would quietly
  // cost the clone its worked example.
  it("keeps the whole demos repo readable", () => {
    const { permissions } = settings();
    for (const tool of ["Read", "Glob", "Grep"]) {
      expect(permissions.allow.some((rule) => rule.startsWith(`${tool}(`) && rule.includes("/repo"))).toBe(true);
    }
  });
});

describe("parseAgentOutput", () => {
  it("extracts result and cost from an --output-format json payload", () => {
    expect(parseAgentOutput(JSON.stringify({ result: "done", total_cost_usd: 1.23 })))
      .toEqual({ output: "done", costUsd: 1.23, isError: false, permissionDenials: [] });
  });

  it("reads is_error out of the payload", () => {
    expect(parseAgentOutput(JSON.stringify({ result: "budget exceeded", is_error: true })))
      .toEqual({ output: "budget exceeded", isError: true, permissionDenials: [] });
  });

  it("falls through with raw stdout when the CLI printed no JSON", () => {
    expect(parseAgentOutput("Error: claude: command not found")).toEqual({
      output: "Error: claude: command not found",
      isError: false,
      permissionDenials: [],
    });
  });

  // An agent that tried to leave its folder is an operator-visible fact: this is
  // the field that proves the sandbox — and the empty list under
  // bypassPermissions is what proved there wasn't one.
  it("names every write the permission layer refused, with its path", () => {
    const parsed = parseAgentOutput(JSON.stringify({
      result: "blocked",
      permission_denials: [
        { tool_name: "Write", tool_use_id: "t1", tool_input: { file_path: "/repo/host/src/vendo-kit/index.ts" } },
        { tool_name: "Edit", tool_use_id: "t2", tool_input: { file_path: "/repo/demos/acme/theme.json" } },
      ],
    }));
    expect(parsed.permissionDenials).toEqual([
      "Write /repo/host/src/vendo-kit/index.ts",
      "Edit /repo/demos/acme/theme.json",
    ]);
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
