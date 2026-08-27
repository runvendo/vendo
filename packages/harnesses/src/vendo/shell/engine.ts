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
import { log, type IFileSystem } from "@vendoai/core";
import type { Bash as BashInstance, SecurityViolation } from "just-bash";
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

/** Violation types already reported, PROCESS-wide.
 *
 *  Process-wide rather than per session for two independent reasons. just-bash's
 *  defense box is a process singleton whose `getInstance` THROWS a config
 *  conflict unless every `Bash` in the process passes the identical
 *  `onViolation` reference, so this has to be one stable function rather than a
 *  per-session closure. And the volume: a host async tracker trips
 *  `performance_timing`/`weak_ref` on nearly every promise the shell makes —
 *  1294 times in one measured turn — so a line per violation is a line per
 *  promise, which is noise an operator learns to filter. One line per type is
 *  the whole signal: which host global the box touched, and that nothing was
 *  blocked. It also bounds the recursion if the log sink itself trips a guard
 *  (`process_stderr` is one), because the second trip is already reported. */
const reportedViolations = new Set<string>();

const reportViolation = (violation: SecurityViolation): void => {
  if (reportedViolations.has(violation.type)) return;
  reportedViolations.add(violation.type);
  log({
    code: "harnesses.shell-defense-audit",
    level: "warn",
    message: `[vendo] shell: host code reached ${violation.path} (${violation.type}) inside just-bash's `
      + "main-thread box. AUDITED AND ALLOWED — this box is the secondary layer and does not block here; "
      + "containment stays with the QuickJS worker's own defense layer, the workspace's permission mounts, "
      + `and the guard. Further ${violation.type} violations this process are not logged.`,
  });
};

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
      // just-bash's MAIN-THREAD box patches host globals while a command runs.
      // Inside a HOST's process that is not containment, it is a crash: an
      // async-hooks `init` callback the host installed (Next dev's React async
      // tracker is one, an APM agent is another) fires on the box's own first
      // promise, touches `performance.now()`/`new WeakRef()`, and the box
      // throws — from `emitInitNative`, where Node treats any exception as
      // fatal, so no try/catch of ours is even on the stack. The demo host's dev
      // server died on the FIRST bash call, deterministically.
      //
      // So audit: report the violation, let it through. The box's only
      // enforcement action inside a host process is "kill the host", which is
      // worse than the intrusion it guards against, and it was never the layer
      // that contains a script — `WorkerDefenseInDepth` inside the QuickJS
      // worker is separate, always on, and untouched by this, as are the
      // workspace's permission mounts, the guard's audit row and kill switch,
      // and the absent network.
      //
      // Not `excludeViolationTypes`: that list names React's MINIFIED internals,
      // so it breaks on their next release, and it would still not cover an APM
      // agent reaching a different guarded global from the same kind of hook —
      // the same structural failure, and that one can hit production.
      defenseInDepth: { auditMode: true, onViolation: reportViolation },
      // Network is off by definition: just-bash registers curl/wget only when a
      // `network` or `fetch` option is passed, and neither is.
    });
  };

  return {
    async exec(command) {
      try {
        if (booting === undefined) {
          booting = boot();
          // A REJECTED boot is not cached: the libraries load bundler-blind on
          // first use, and one blink there must not answer every later call in
          // the turn with the same stale failure (same as `open`, tool.ts:179).
          void booting.catch(() => { booting = undefined; });
        }
        const bash = await booting;
        const { stdout, stderr, exitCode } = await bash.exec(command);
        return { stdout, stderr, exitCode };
      } catch (error) {
        // The workspace refuses a write outside the caller's mounts by THROWING
        // (`EACCES`, store/src/workspace-fs.ts:65), and just-bash lets that out of
        // `exec` instead of turning it into an exit code. A path the person's own
        // filesystem refused is an ordinary shell failure, not a broken tool call:
        // the model has to READ it and pick another path, which it cannot do if
        // the turn dies instead. A boot that fails is inside the same boundary
        // for the same reason: an unloadable library is a shell that is down, not
        // a tool call that is broken.
        return { stdout: "", stderr: `${(error as Error).message}\n`, exitCode: 1 };
      }
    },
  };
}
