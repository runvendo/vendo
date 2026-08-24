/**
 * The agent's hands: ONE bash session over one caller's workspace, in this
 * process, with no machine anywhere.
 *
 * The disk is the caller's own `WorkspaceFs` — the store, wearing just-bash's
 * `IFileSystem` (build contract §3.2) — so a script reads and writes exactly the
 * files that person already has, under exactly the mounts §3.1 froze
 * (`/user`, `/orgs/<org>` rw, `/host` ro). There is no path argument to escape
 * with and no host disk to reach: a write outside the mounts is `EACCES` from
 * the filesystem itself, not from a check bolted on here.
 */
import type { IFileSystem } from "@vendoai/core";
import type { Bash as BashInstance } from "just-bash";
import { docx2txt } from "./parsers/docx2txt.js";
import { pdftotext } from "./parsers/pdftotext.js";
import { xlsx2csv } from "./parsers/xlsx2csv.js";
import { importShellLibrary } from "./runtime.js";

/** One `bash` call's ceilings. Both map onto just-bash's own execution limits;
 *  everything else keeps just-bash's `normal` profile. */
export interface ShellLimits {
  /** Wall clock for ONE call, in milliseconds. */
  maxExecutionTimeMs?: number;
  /** Total stdout + stderr bytes one call may produce. */
  maxOutputBytes?: number;
}

/** What a turn holds: a shell that keeps its filesystem between calls. */
export interface ShellSession {
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** A turn is a person waiting, so the default is the length of a person's
 *  patience rather than just-bash's compatibility-oriented hour. */
export const DEFAULT_MAX_EXECUTION_TIME_MS = 30_000;
/** Generous next to the 32 000-char tool-output cap the bridge applies, because
 *  a script may legitimately produce a lot and pipe it into `tail`; the cap is
 *  what the MODEL sees, this is what the SHELL may make. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
/** What the whole session's `/tmp` may hold. `maxOutputBytes` bounds ONE
 *  redirect and nothing bounded the session, so a turn that kept appending grew
 *  this in-process filesystem without limit. Not a `ShellLimits` knob: it is
 *  memory this process has to survive, not a ceiling a deployment tunes — 32× the
 *  default per-call output, and 6× the 5 MB an upload may be, so a script can
 *  still hold several copies of the largest file a person can drop. */
const TMP_MAX_BYTES = 32 * 1024 * 1024;

type JustBash = typeof import("just-bash");

/**
 * One session, one workspace. The interpreter boots on the FIRST call and is
 * kept: booting it costs a module load, and a turn that runs three commands
 * should pay that once.
 */
export function createShellSession(opts: {
  workspace: IFileSystem;
  limits?: ShellLimits;
  javascript?: boolean;
}): ShellSession {
  let booting: Promise<BashInstance> | undefined;

  const boot = async (): Promise<BashInstance> => {
    const { Bash, InMemoryFs, MountableFs } = await importShellLibrary<JustBash>("just-bash");
    // `/tmp` is the one place a script may scribble that is NOT the person's
    // workspace. It has to exist: the workspace holds `/user`, `/orgs/<org>` and
    // `/host` and answers EACCES everywhere else, and a shell with nowhere to put
    // an intermediate is a shell that can only run one-liners. In memory, and
    // owned by the session, so it lasts exactly as long as the turn does.
    const fs = new MountableFs({ base: opts.workspace });
    fs.mount("/tmp", new InMemoryFs(undefined, { maxTotalBytes: TMP_MAX_BYTES }));
    return new Bash({
      fs,
      // The person's own mount, so the paths the agent types are the paths the
      // user's files actually have.
      cwd: "/user",
      javascript: opts.javascript === true,
      // The binary formats a person actually drops into chat, as ordinary
      // commands: they pipe, they redirect, and the agent needs no special
      // vocabulary for them. Lazy, so their libraries load on first use.
      customCommands: [pdftotext, xlsx2csv, docx2txt],
      executionLimits: {
        maxExecutionTimeMs: opts.limits?.maxExecutionTimeMs ?? DEFAULT_MAX_EXECUTION_TIME_MS,
        maxOutputSize: opts.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      },
      // Network is off by definition: just-bash registers curl/wget only when a
      // `network` or `fetch` option is passed, and neither is.
    });
  };

  return {
    async exec(command) {
      const bash = await (booting ??= boot());
      try {
        const { stdout, stderr, exitCode } = await bash.exec(command);
        return { stdout, stderr, exitCode };
      } catch (error) {
        // The workspace refuses a write outside the caller's mounts by THROWING
        // (`EACCES`, store/src/workspace-fs.ts:65), and just-bash lets that out of
        // `exec` instead of turning it into an exit code. A path the person's own
        // filesystem refused is an ordinary shell failure, not a broken tool call:
        // the model has to READ it and pick another path, which it cannot do if
        // the turn dies instead.
        return { stdout: "", stderr: `${(error as Error).message}\n`, exitCode: 1 };
      }
    },
  };
}
