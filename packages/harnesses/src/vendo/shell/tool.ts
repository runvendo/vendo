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
import { workerThreadsAvailable } from "./runtime.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** Told once per process: the answer cannot change while it runs, and a probe
 *  per descriptor call would be asked on every listing. */
const JAVASCRIPT = workerThreadsAvailable();

const DESCRIPTION =
  "Run a bash command over this user's own files. You have a real shell — grep, sed, awk, jq, sort, "
  + "cut, head, tail, wc, find, pipes and redirection all work — and the filesystem IS the user's "
  + "workspace: /user/threads/<thread>/files holds what they dropped in THIS conversation, "
  + "/user/apps/<app> holds an app's files, and /user/files is the shelf of things they asked you to "
  + "keep. /tmp is scratch that lasts this conversation and is never saved. "
  + "When you build an app OUT OF a file the user dropped, `cp` it into "
  + "/user/apps/<app>/ first and parse it there: a conversation's files are deleted with the "
  + "conversation, and an app must not depend on one. "
  + "Binary formats are ordinary commands here: `pdftotext <file>`, `xlsx2csv <file> [sheet]` and "
  + "`docx2txt <file>` each write text to stdout, so they pipe into grep, awk and the rest. "
  + (JAVASCRIPT
    ? "For anything bash is awkward at, write JavaScript: `js-exec -c '<code>'` runs it in a sandbox with "
      + "require(\"node:fs\") bound to this same filesystem. "
    : "")
  + "There is no network and no package manager: everything you need is already here. "
  + "Prefer this over reading a file line by line — one command answers what twenty reads would.";

const descriptors: ToolDescriptor[] = [
  {
    name: VENDO_BASH_TOOL,
    title: VENDO_TOOL_TITLES[VENDO_BASH_TOOL]!,
    description: DESCRIPTION,
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

/** The bridge's default `toolOutputCap`, mirrored because the layering forbids
 *  importing `@vendoai/vendo`'s `DEFAULT_TOOL_OUTPUT_CAP` from here. `capOutcome`
 *  does not clip at it, it REPLACES the whole result with a preview string,
 *  throwing away the exit code and the stderr a failing command is diagnosed
 *  from — so the shell stays under it itself. */
const BRIDGE_CAP_CHARS = 32_000;

/** `{"stdout":"…","stderr":"…","exitCode":0}` — the keys and punctuation the two
 *  streams sit inside, which `JSON.stringify` weighs too. */
const ENVELOPE_CHARS = 64;

/** What ONE stream may hand back, so BOTH plus the envelope stay under the cap.
 *  Clipping keeps the TAIL — the end of a long output is where a script's answer
 *  and its error both live.
 *
 *  Counted in JSON characters, not raw ones: `capOutcome` weighs
 *  `JSON.stringify(output)`, where a newline costs two characters and a control
 *  byte six, so a raw budget let an all-newline stream (`cut` over empty fields,
 *  a bare `find`) reach the very cap this exists to stay under. */
const MAX_STREAM_JSON_CHARS = (BRIDGE_CAP_CHARS - ENVELOPE_CHARS) / 2;

/** What `text` costs inside a JSON string, quotes excluded. */
const jsonLength = (text: string): number => JSON.stringify(text).length - 2;

const note = (dropped: number): string =>
  `[clipped] ${dropped} earlier characters dropped; `
  + `re-run with head/tail/grep to see them.\n`;

/** The longest TAIL of `text` that fits `budget` JSON characters. Spent
 *  character by character from the end, because escaping is per character and
 *  the end is the half worth keeping. */
const tail = (text: string, budget: number): string => {
  let spent = 0;
  let start = text.length;
  while (start > 0) {
    const cost = jsonLength(text[start - 1]!);
    if (spent + cost > budget) break;
    spent += cost;
    start -= 1;
  }
  return text.slice(start);
};

const clip = (text: string): string => {
  if (jsonLength(text) <= MAX_STREAM_JSON_CHARS) return text;
  // The note is INSIDE the budget, not on top of it — the cap is what one stream
  // may hand back in TOTAL, and half the bridge's is only headroom if the note
  // counts. Reserved against `text.length`, the largest the drop can ever be, so
  // the digits are never underestimated and the result never exceeds the cap.
  const kept = tail(text, MAX_STREAM_JSON_CHARS - jsonLength(note(text.length)));
  return note(text.length - kept.length) + kept;
};

/** Sessions outlive a call and nothing here is told a turn ended, so the cache is
 *  BOUNDED rather than swept: the oldest entry leaves when a new one would be the
 *  33rd. A turn evicted early re-opens on its next call and loses only `/tmp`,
 *  which is the one thing in the session that was never durable anyway. */
const MAX_LIVE_SESSIONS = 32;

interface Turn {
  session: ShellSession;
  workspace: WorkspaceFs;
  /** This turn's calls run ONE at a time. A model may emit two `bash` calls in a
   *  single step and the AI SDK runs those together, and they share a workspace
   *  whose writes STAGE until `commit()` — two in flight over one staging area is
   *  one call committing the other's half-written files. */
  queue: Promise<unknown>;
}

export function createShellTools(
  open: (principal: Principal) => Promise<WorkspaceFs>,
  config: { limits?: ShellLimits } = {},
): ToolRegistry {
  const live = new Map<string, Promise<Turn>>();

  const openTurn = async (principal: Principal): Promise<Turn> => {
    const workspace = await open(principal);
    return {
      workspace,
      session: createShellSession({
        workspace,
        javascript: JAVASCRIPT,
        ...(config.limits === undefined ? {} : { limits: config.limits }),
      }),
      queue: Promise.resolve(),
    };
  };

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
      const command = args.command;
      // ONE session per TURN: `/tmp` is where a multi-step script keeps its
      // intermediates, and a fresh interpreter per call would throw them away
      // between `sort > /tmp/x` and `cat /tmp/x`. Keyed on `turnId` because that
      // is the only thing a tool call carries meaning "same conversation, still
      // going"; a run with no turn (a webhook, a schedule fire) falls back to its
      // session so it is at least not sharing with anyone else.
      const key = ctx.turnId ?? `session:${ctx.principal.subject}:${ctx.sessionId}`;
      let opening = live.get(key);
      if (opening === undefined) {
        if (live.size >= MAX_LIVE_SESSIONS) live.delete(live.keys().next().value!);
        // The PROMISE is cached, before anything is awaited. A check-then-set
        // around `open` lets a second concurrent call for the same turn find
        // nothing, build a second workspace, and overwrite the first — whose
        // `/tmp` and staged writes are then unreachable.
        opening = openTurn(ctx.principal);
        live.set(key, opening);
        // A REJECTED open is not cached, though: the store blinking once must
        // not wedge the rest of the turn. Guarded on identity so a turn that was
        // evicted and re-opened keeps its newer entry.
        const failed = opening;
        void failed.catch(() => {
          if (live.get(key) === failed) live.delete(key);
        });
      }
      const turn = await opening;
      const run = turn.queue.then(async () => ({
        result: await turn.session.exec(command),
        committed: await turn.workspace.commit(),
      }));
      turn.queue = run.catch(() => undefined);
      const { result, committed } = await run;
      if (committed.status === "conflict") {
        // `/orgs` is compare-and-swap and a commit batches PER OWNER
        // (store/src/workspace-fs.ts:592-595), so the losing swap is the only
        // thing rolled back — the same command's `/user` writes DID land. Saying
        // `ok` would hide the lost write; saying nothing was saved would send the
        // model to re-run a command that already half-applied.
        return fail(
          "conflict",
          `Someone else changed ${committed.paths.join(", ")} while this ran, so the writes to those `
          + `paths were rejected. Anything this command wrote elsewhere DID land. Re-read those paths `
          + `and redo only that part.`,
        );
      }
      return ok({ stdout: clip(result.stdout), stderr: clip(result.stderr), exitCode: result.exitCode });
    },
  };
}
