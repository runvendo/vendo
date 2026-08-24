/**
 * The shell's hand on the ONE registry.
 *
 * Modelled on the drawer's tools (`@vendoai/vendo` user-files.ts): a
 * `ToolRegistry` whose descriptor carries its own `risk`, whose every call opens
 * the workspace for `ctx.principal` and NOBODY else, and which commits what the
 * call wrote before answering. There is no subject argument to get wrong.
 */
import {
  VENDO_BASH_TOOL,
  VENDO_TOOL_TITLES,
  type Principal,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
  type WorkspaceFs,
} from "@vendoai/core";
import { createShellSession, type ShellLimits, type ShellSession } from "./engine.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const descriptors: ToolDescriptor[] = [
  {
    name: VENDO_BASH_TOOL,
    title: VENDO_TOOL_TITLES[VENDO_BASH_TOOL]!,
    description:
      "Run a bash command over this user's own files. You have a real shell — grep, sed, awk, jq, sort, "
      + "cut, head, tail, wc, find, pipes and redirection all work — and the filesystem IS the user's "
      + "workspace: /user/threads/<thread>/files holds what they dropped in THIS conversation, "
      + "/user/apps/<app> holds an app's files, and /user/files is the shelf of things they asked you to "
      + "keep. /tmp is scratch that lasts this conversation and is never saved. "
      + "There is no network and no package manager: everything you need is already here. "
      + "Prefer this over reading a file line by line — one command answers what twenty reads would.",
    inputSchema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: { command: { type: "string", minLength: 1 } },
      required: ["command"],
      additionalProperties: false,
    },
    risk: "write",
  },
];

const ok = (output: Record<string, unknown>): ToolOutcome => ({ status: "ok", output: output as never });
const fail = (code: string, message: string): ToolOutcome => ({ status: "error", error: { code, message } });

export function createShellTools(
  open: (principal: Principal) => Promise<WorkspaceFs>,
  config: { limits?: ShellLimits } = {},
): ToolRegistry {
  return {
    async descriptors() {
      return structuredClone(descriptors);
    },
    async execute(call, ctx): Promise<ToolOutcome> {
      if (call.tool !== VENDO_BASH_TOOL) return fail("not-found", `Unknown tool: ${call.tool}`);
      const args = (call.args ?? {}) as { command?: unknown };
      if (typeof args.command !== "string" || args.command.trim() === "") {
        return fail("validation", "command must be the shell command to run, as a single string");
      }
      const workspace = await open(ctx.principal);
      const session: ShellSession = createShellSession({
        workspace,
        ...(config.limits === undefined ? {} : { limits: config.limits }),
      });
      const result = await session.exec(args.command);
      await workspace.commit();
      return ok({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
    },
  };
}
