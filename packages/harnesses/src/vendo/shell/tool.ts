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

/** What ONE stream may hand back. Half the bridge's 32 000-char cap, so stdout
 *  and stderr together can never reach it: `capOutcome` does not clip, it
 *  REPLACES the whole result with a preview string, which would throw away the
 *  exit code and the stderr a failing command is diagnosed from. Clipping is the
 *  shell's own job, and it keeps the TAIL — the end of a long output is where a
 *  script's answer and its error both live. */
const MAX_STREAM_CHARS = 16_000;

const note = (dropped: number): string =>
  `[clipped] ${dropped} earlier characters dropped; `
  + `re-run with head/tail/grep to see them.\n`;

const clip = (text: string): string => {
  if (text.length <= MAX_STREAM_CHARS) return text;
  // The note is INSIDE the budget, not on top of it — the cap is what one stream
  // may hand back in TOTAL, and half the bridge's is only headroom if the note
  // counts. Reserved against `text.length`, the largest the drop can ever be, so
  // the digits are never underestimated and the result never exceeds the cap.
  const kept = MAX_STREAM_CHARS - note(text.length).length;
  return note(text.length - kept) + text.slice(text.length - kept);
};

/** Sessions outlive a call and nothing here is told a turn ended, so the cache is
 *  BOUNDED rather than swept: the oldest entry leaves when a new one would be the
 *  33rd. A turn evicted early re-opens on its next call and loses only `/tmp`,
 *  which is the one thing in the session that was never durable anyway. */
const MAX_LIVE_SESSIONS = 32;

export function createShellTools(
  open: (principal: Principal) => Promise<WorkspaceFs>,
  config: { limits?: ShellLimits } = {},
): ToolRegistry {
  const live = new Map<string, { session: ShellSession; workspace: WorkspaceFs }>();
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
      // ONE session per TURN: `/tmp` is where a multi-step script keeps its
      // intermediates, and a fresh interpreter per call would throw them away
      // between `sort > /tmp/x` and `cat /tmp/x`. Keyed on `turnId` because that
      // is the only thing a tool call carries meaning "same conversation, still
      // going"; a run with no turn (a webhook, a schedule fire) falls back to its
      // session so it is at least not sharing with anyone else.
      const key = ctx.turnId ?? `session:${ctx.principal.subject}:${ctx.sessionId}`;
      let held = live.get(key);
      if (held === undefined) {
        if (live.size >= MAX_LIVE_SESSIONS) live.delete(live.keys().next().value!);
        const workspace = await open(ctx.principal);
        held = {
          workspace,
          session: createShellSession({
            workspace,
            ...(config.limits === undefined ? {} : { limits: config.limits }),
          }),
        };
        live.set(key, held);
      }
      const result = await held.session.exec(args.command);
      await held.workspace.commit();
      return ok({ stdout: clip(result.stdout), stderr: clip(result.stderr), exitCode: result.exitCode });
    },
  };
}
