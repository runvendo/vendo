import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createClaudeSession,
  VENDO_MCP_SERVER,
  type ClaudeTurnEvent,
} from "../../src/claude-code/claude-turn.js";

/**
 * A stand-in for the SDK's own stream: it yields the message shapes the real one
 * yields, one scripted turn per user message pushed in. Nothing here mocks OUR
 * code — it simulates the SDK, which is the boundary a unit test cannot run.
 *
 * **What this fake no longer needs to do.** It used to stand in for an in-process
 * MCP server (build the projected handler map, reproduce zod's key-stripping) and
 * then for the CLI's permission dispatch (consult `canUseTool` per tool use).
 * door-ctx moved execution to the host's own MCP door, and D1 deleted the
 * permission callback — the session runs in `bypassPermissions`, so a tool use is
 * simply a tool use. The door half is covered end-to-end by
 * `packages/vendo/src/mcp-door-parity.e2e.test.ts` instead.
 */
interface ScriptStep {
  say?: string;
}

function fakeSdk(script: ScriptStep[], sessionId = "sess_fake") {
  return {
    query: ({ prompt }: { prompt: unknown }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: sessionId };
        // One scripted turn per user message pushed in; the stream stays open
        // until the caller closes it.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _message of prompt as AsyncIterable<any>) {
        for (const step of script) {
          if (step.say !== undefined) {
            yield { type: "assistant", message: { content: [{ type: "text", text: step.say }] } };
          }
        }
        yield {
          type: "result",
          subtype: "success",
          session_id: sessionId,
          usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
        };
        }
      },
    }),
  };
}

const TOOL_DOOR = { url: "https://app.example.com/api/vendo/mcp", token: "vtk_secret" };

/** ONE message through a live session — the shape every test below wants. */
async function run(
  script: ScriptStep[],
  extra: { toolDoor?: { url: string; token: string } } = {},
) {
  const events: ClaudeTurnEvent[] = [];
  const opened: Array<Record<string, any>> = [];
  const sdk = fakeSdk(script);
  const session = createClaudeSession({
    cwd: "/box/user",
    env: {},
    emit: (event) => events.push(event),
    sdk: {
      query: (params: any) => {
        opened.push(params.options);
        return sdk.query(params);
      },
    } as never,
    ...extra,
  });
  await session.send("do the thing");
  await session.end();
  return { events, options: opened[0]! };
}

describe("the composed brief reaches the SDK — the D2 plumbing question", () => {
  /**
   * Written to ANSWER a question, not to fix a bug: finding D2 had
   * `claudeCode()` report a recurring automation it never created, and the first
   * candidate cause was `Turn.system` — the block carrying "Never claim a tool
   * ran unless its result confirms that it did" — being dropped or truncated on
   * the way to the SDK loop. This hop had no coverage at all, so the answer was
   * a reading rather than a measurement. It is not dropped: it arrives whole,
   * APPENDED to the co-trained preset. D2's cause therefore lies in what the
   * model does with a brief it received, not in whether it received one.
   */
  const captureOptions = async (systemPrompt: string | undefined): Promise<Record<string, any>> => {
    let seen: Record<string, any> = {};
    const inner = fakeSdk([{ say: "ok" }]);
    const session = createClaudeSession({
      cwd: "/box/user",
      env: {},
      emit: () => undefined,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      sdk: {
        ...inner,
        query: (params: { prompt: unknown; options: Record<string, any> }) => {
          seen = params.options;
          return inner.query(params);
        },
      } as never,
    });
    await session.send("do the thing");
    await session.end();
    return seen;
  };

  test("it is APPENDED to the claude_code preset, never replacing it", async () => {
    const brief = "Never claim a tool ran unless its result confirms that it did.";
    const options = await captureOptions(brief);
    expect(options["systemPrompt"]).toEqual({
      type: "preset",
      preset: "claude_code",
      append: brief,
    });
  });

  test("a caller with no brief still gets the preset, never an empty system prompt", async () => {
    expect(await captureOptions(undefined)).toMatchObject({
      systemPrompt: { type: "preset", preset: "claude_code", append: "" },
    });
  });

  test("the user's own files can never configure the harness", async () => {
    // `settingSources: []` is why a CLAUDE.md in the materialized workspace is
    // inert: the brief is ours, the workspace is theirs.
    expect((await captureOptions("brief"))["settingSources"]).toEqual([]);
  });
});

describe("the tools are the HOST's MCP door — the projection is gone", () => {
  test("the session points at the door's URL and carries the turn credential as a Bearer", async () => {
    const { options } = await run([], { toolDoor: TOOL_DOOR });
    expect(options.mcpServers).toEqual({
      [VENDO_MCP_SERVER]: {
        type: "http",
        url: TOOL_DOOR.url,
        headers: { Authorization: `Bearer ${TOOL_DOOR.token}` },
        alwaysLoad: true,
      },
    });
  });

  test("`alwaysLoad` — our tools are already curated, so the engine must not defer them behind its own tool search", async () => {
    const { options } = await run([], { toolDoor: TOOL_DOOR });
    expect(options.mcpServers[VENDO_MCP_SERVER].alwaysLoad).toBe(true);
  });

  test("no door, no MCP server — a host that never opened one gets the box's own hands and nothing else", async () => {
    const { options } = await run([]);
    expect(options.mcpServers).toBeUndefined();
  });

  test("the door is the ONLY server — a `.mcp.json` in the box cannot mount another", async () => {
    // `settingSources: []` closes settings discovery; the SDK documents a project
    // `.mcp.json` as something only `strictMcpConfig` ignores, and the box's cwd is
    // a disk the model writes itself. Tools mounted that way would be `mcp__*`
    // names outside the deny-list, the guard, the audit log and egress filtering.
    const { options } = await run([], { toolDoor: TOOL_DOOR });
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
  });

  test("strictness is not conditional on a door — a box with no server admits none either", async () => {
    expect((await run([])).options.strictMcpConfig).toBe(true);
  });
});

describe("permissions — the box is the permission, the door is the permission (D1)", () => {
  test("the session bypasses the SDK's permission system entirely — the mode AND its flag", async () => {
    // The SDK documents the two as a PAIR: the flag is what makes the transport
    // pass `--allow-dangerously-skip-permissions`. Today's CLI treats it as
    // advisory (measured 2026-08-03) — asserted so a CLI that starts enforcing
    // its own documented requirement can't break a real session silently.
    const { options } = await run([], { toolDoor: TOOL_DOOR });
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.allowDangerouslySkipPermissions).toBe(true);
  });

  test("no permission callback — the guard decides at the door, not in this process", async () => {
    const { options } = await run([], { toolDoor: TOOL_DOOR });
    expect(options).not.toHaveProperty("canUseTool");
  });

  test("no allow-list — an allow-list here can only subtract capability from a contained box", async () => {
    // The one it replaced denied SDK tools the file-sync hook below already
    // expected (`MultiEdit`, `NotebookEdit`), and every tool a future SDK ships.
    const { options } = await run([], { toolDoor: TOOL_DOOR });
    expect(options).not.toHaveProperty("allowedTools");
  });

  test("the deny-list is the whole of the local tool law — these names, exactly", async () => {
    // Three groups: nothing a headless turn cannot do (no user, no egress); the
    // SDK's provider-side tools, which reach the vendor's surfaces over the
    // inference channel and so pass neither the box nor the door; and the
    // scheduling family, which leaves execution running after the turn that asked
    // for it has ended — no turn left to be accountable to, so no guard, no audit
    // row, no egress filter.
    const { options } = await run([]);
    expect(options.disallowedTools).toEqual([
      "WebSearch",
      "WebFetch",
      "AskUserQuestion",
      "Projects",
      "Artifact",
      "PushNotification",
      "SendFeedback",
      "ClaudeDesign",
      "RemoteTrigger",
      "CronCreate",
      "CronDelete",
      "CronList",
      "ScheduleWakeup",
    ]);
  });
});

/**
 * Every tool name the SDK's own generated schemas enumerate, read out of the
 * INSTALLED package rather than restated here.
 *
 * `sdk-tools.d.ts` is generated from the CLI's JSON Schemas, which makes it the
 * closest thing to a machine-readable tool list the SDK ships. It is TYPES only —
 * there is no runtime constant, and TypeScript cannot recover an alias name from a
 * union member, so no `satisfies` trick reaches these — hence reading the union as
 * TEXT. Its members are SCHEMA names, which are not always tool names
 * (`FileReadInput` belongs to the `Read` tool), so the ledger below classifies
 * schema names; every name the deny-list carries happens to be spelled the same in
 * both.
 */
function sdkToolSchemaNames(): string[] {
  const resolve = createRequire(import.meta.url).resolve;
  const declarations = readFileSync(
    join(dirname(resolve("@anthropic-ai/claude-agent-sdk")), "sdk-tools.d.ts"),
    "utf8",
  );
  const names = new Set<string>();
  for (const union of ["ToolInputSchemas", "ToolOutputSchemas"]) {
    const body = new RegExp(`export type ${union} =([^;]*);`).exec(declarations)?.[1];
    if (body === undefined) {
      throw new Error(
        `the installed SDK no longer declares \`${union}\` in sdk-tools.d.ts — the ledger in claude-turn.test.ts has to be re-derived from whatever enumerates the tools now.`,
      );
    }
    for (const member of body.split("|")) {
      const name = /^(\w+)(?:Input|Output)$/.exec(member.trim())?.[1];
      if (name !== undefined) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * The tools that RUN, classified by hand once against the shipped CLI's own
 * constants (2.1.220).
 *
 * Every one of these acts inside the box or through the door, so it lands under
 * something that decides: the box is the permission for its own hands, the guard is
 * the permission for host tools. The task family is the SESSION's own task list
 * ("Create a new task in the task list"), not a provider-side store;
 * `ShowOnboardingRolePicker` is interactive-only and inert in a headless turn; and
 * `ProposeSkills` is in the SDK's schemas with ZERO occurrences in the shipped CLI
 * binary, so it is schema-only and denying it would deny nothing.
 */
const RUNS_UNDER_SOMETHING_THAT_DECIDES = [
  "Agent", "Bash", "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree",
  "FileEdit", "FileRead", "FileWrite", "Glob", "Grep", "ListMcpResources", "Mcp",
  "Monitor", "NotebookEdit", "ProposeSkills", "REPL", "ReadMcpResource",
  "ReadMcpResourceDir", "RefreshMcpTools", "ReportFindings",
  "ShowOnboardingRolePicker", "TaskCreate", "TaskGet", "TaskList", "TaskOutput",
  "TaskStop", "TaskUpdate", "TodoWrite", "Workflow",
];

describe("the deny-list is read against the SDK's own tool schemas", () => {
  /**
   * The defect this closes: `disallowedTools` names the tools we refuse, and an SDK
   * bump that ships a new one is silently ADMITTED — nothing fails, nothing warns,
   * and the tool is simply in the model's hands. That is how the whole scheduling
   * family (`CronCreate`, `ScheduleWakeup`, …) got in: it shipped, the eight-name
   * list did not move, and a review a version later found it.
   *
   * So every name the SDK's schemas enumerate must be classified — refused, or
   * reviewed and allowed. A thirteenth-hour SDK addition lands in neither and fails
   * here, by name.
   */
  test("a tool a future SDK adds cannot be admitted in silence", async () => {
    const { options } = await run([]);
    const classified = new Set<string>([
      ...(options.disallowedTools as string[]),
      ...RUNS_UNDER_SOMETHING_THAT_DECIDES,
    ]);
    const unclassified = sdkToolSchemaNames().filter((name) => !classified.has(name));
    expect(
      unclassified,
      `the installed SDK ships tool schemas this deny-list has never been read against: ${unclassified.join(", ")}. `
      + "Read the name out of the shipped CLI's own constants (~/.local/share/claude/versions/, not the SDK's type names) and either "
      + "add it to DISALLOWED_TOOLS in claude-turn.ts or classify it in RUNS_UNDER_SOMETHING_THAT_DECIDES here.",
    ).toEqual([]);
  });

  /**
   * The other direction, which the forward check cannot see: a RENAME. If
   * `CronCreate` becomes `ScheduleCreate`, the forward check catches the arrival but
   * the deny-list keeps a dead string, and the door is open again. A refused name
   * that no longer exists in the SDK's schemas is that signal.
   */
  test("every refused name still exists in the SDK's schemas — a rename reopens the door", async () => {
    const { options } = await run([]);
    const shipped = new Set(sdkToolSchemaNames());
    const vanished = (options.disallowedTools as string[]).filter((name) => !shipped.has(name));
    expect(
      vanished,
      `these names are refused but the installed SDK no longer enumerates them: ${vanished.join(", ")}. `
      + "Either the tool is gone (drop the name) or it was RENAMED, in which case the replacement is now allowed.",
    ).toEqual([]);
  });
});

describe("events — the closed vocabulary (§1.5)", () => {
  test("assistant text becomes text deltas", async () => {
    const { events } = await run([{ say: "Here you go." }]);
    expect(events.filter((e) => e.type === "text")).toEqual([{ type: "text", delta: "Here you go." }]);
  });

  test("the native session id is reported so turn.state can carry it", async () => {
    const { events } = await run([]);
    expect(events).toContainEqual({ type: "session", sessionId: "sess_fake" });
  });

  test("the result's usage is reported for metering", async () => {
    const { events } = await run([]);
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
    });
  });
});
