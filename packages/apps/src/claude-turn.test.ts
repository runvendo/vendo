import { describe, expect, test } from "vitest";
import {
  createClaudeSession,
  VENDO_MCP_SERVER,
  type ClaudeTurnEvent,
} from "./claude-turn.js";

/**
 * A faithful stand-in for the CLI's own permission dispatch: for every scripted
 * tool use it consults `canUseTool` exactly as the SDK does, and yields the
 * message shapes the real stream yields. Nothing here mocks OUR code — it
 * simulates the SDK, which is the boundary a unit test cannot run.
 *
 * **What this fake no longer needs to do.** It used to also stand in for an
 * in-process MCP server: build the projected handler map, run the handler after
 * the hook allowed, and reproduce zod's key-stripping so the two views of one
 * call could be compared. door-ctx moved the tools to the host's own MCP door,
 * so an `mcp__vendo__*` use is just a use the hook allows and the ENGINE
 * dispatches over HTTP — out of this file's reach, and covered end-to-end by
 * `packages/vendo/src/mcp-door-parity.e2e.test.ts` instead.
 */
interface ScriptStep {
  say?: string;
  use?: { name: string; input: Record<string, unknown> };
}

interface Recorded {
  permissions: Array<{ name: string; verdict: string; message?: string }>;
}

function fakeSdk(script: ScriptStep[], recorded: Recorded, sessionId = "sess_fake") {
  return {
    query: ({ prompt, options }: { prompt: unknown; options: Record<string, any> }) => ({
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
          if (step.use === undefined) continue;
          const preApproved = (options.allowedTools ?? []).includes(step.use.name);
          let verdict: any = { behavior: "allow", updatedInput: step.use.input };
          if (!preApproved && options.canUseTool !== undefined) {
            verdict = await options.canUseTool(step.use.name, step.use.input, {
              signal: new AbortController().signal,
            });
          }
          recorded.permissions.push({
            name: step.use.name,
            verdict: verdict.behavior,
            ...(verdict.message === undefined ? {} : { message: verdict.message }),
          });
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
  extra: { allowedBoxTools?: string[]; toolDoor?: { url: string; token: string } } = {},
) {
  const events: ClaudeTurnEvent[] = [];
  const recorded: Recorded = { permissions: [] };
  const opened: Array<Record<string, any>> = [];
  const sdk = fakeSdk(script, recorded);
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
  return { events, recorded, options: opened[0]! };
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
    const recorded: Recorded = { permissions: [] };
    const inner = fakeSdk([{ say: "ok" }], recorded);
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

  test("a door tool is ALLOWED by the hook, because the guard decides at the door", async () => {
    const { recorded } = await run(
      [{ use: { name: `mcp__${VENDO_MCP_SERVER}__maple_invoices_list`, input: { limit: 2 } } }],
      { toolDoor: TOOL_DOOR },
    );
    expect(recorded.permissions).toEqual([
      { name: `mcp__${VENDO_MCP_SERVER}__maple_invoices_list`, verdict: "allow" },
    ]);
  });

  test("the box's own file/bash work is auto-allowed — the box IS the permission", async () => {
    const { recorded } = await run([
      { use: { name: "Bash", input: { command: "ls" } } },
      { use: { name: "Write", input: { file_path: "/box/user/a.txt" } } },
    ]);
    expect(recorded.permissions.every((entry) => entry.verdict === "allow")).toBe(true);
  });

  test("a tool nobody named — a future SDK built-in — is DENIED, never auto-allowed", async () => {
    const { recorded } = await run(
      [{ use: { name: "BrandNewEgressTool", input: {} } }],
      { allowedBoxTools: ["Bash"] },
    );
    expect(recorded.permissions).toEqual([
      { name: "BrandNewEgressTool", verdict: "deny", message: "BrandNewEgressTool isn't available in this workspace." },
    ]);
  });

  test("another server's MCP tools are denied — only OUR door's prefix is allowed", async () => {
    const { recorded } = await run(
      [{ use: { name: "mcp__somebody_else__exfiltrate", input: {} } }],
      { toolDoor: TOOL_DOOR },
    );
    expect(recorded.permissions[0]?.verdict).toBe("deny");
  });

  test("the SDK's subagent door stays open — a Task dispatch is allowed", async () => {
    const { recorded } = await run([{ use: { name: "Task", input: { prompt: "go" } } }]);
    expect(recorded.permissions).toEqual([{ name: "Task", verdict: "allow" }]);
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
