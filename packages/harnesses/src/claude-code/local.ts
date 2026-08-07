/**
 * `machine: "local"` — build list item 7.
 *
 * The explicit opt-in that runs the Agent SDK on the host's own server: the
 * workspace materializes to a temp dir, and the SAME sync-back seam lands the
 * diff. Never the default — a spawned-CLI harness without a sandbox is a boot
 * error (design §9), and this is the escape hatch a host chooses on purpose.
 *
 * Tools reach the host's MCP door exactly as the box's do (10-mcp §3b), over a
 * real HTTP round trip to the deployment's own base URL. That is deliberate
 * sameness: `machine: "local"` is an opt-in about WHERE the SDK runs, and making
 * it a second tool transport is what turned it into a second implementation of
 * the same harness before.
 *
 * The SDK arrives by DYNAMIC import, bundler-ignored: it is an optional peer, so
 * neither `tsc`, nor a host's BUILD, nor a host who never opts in ever needs the
 * ~250MB platform binary on disk. This file is the only place on any host path
 * that names it.
 *
 * **What this mode does NOT have: a box.** The session runs its own tools
 * unprompted (`permissionMode: "bypassPermissions"`, claude-turn.ts) on the
 * stated grounds that "the box IS the permission — copies only, no
 * credentials, reality happens at commit". Here:
 *
 *   - "copies only" is FALSE. `cwd` is a directory the shell is POINTED at, not
 *     a boundary it is held inside; `Bash` runs as the host's own server process
 *     over the host's own filesystem and network, with no egress allowlist
 *     because there is no provider network layer to hang one on.
 *   - "no credentials" is TRUE OF THE ENVIRONMENT, and only that. Measured in
 *     the Agent SDK's own spawn (0.3.215: `xt ? {...xt} : {...process.env}`,
 *     with no merge-style `...process.env,` anywhere): passing `env` REPLACES
 *     the host environment rather than merging into it, so the subprocess sees
 *     our `inferenceEnv()` values and NOT the host server's other secrets.
 *     That is a real containment and worth knowing.
 *   - But it stops at the environment. Secrets AT REST are untouched by it: a
 *     `.env` file, `~/.aws/credentials`, a service-account JSON, a kubeconfig —
 *     anything the host OS user can read, `Bash` can read, because it IS that
 *     user. A scoped env does not make the disk unreadable.
 *
 * Everything driving that shell is end-user chat. So this mode grants what a
 * shell account on the deployment grants, and the operator is told so, once, on
 * the first turn ({@link warnLocalRiskOnce}). The sandbox path is the safe one,
 * and the default.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VendoError } from "@vendoai/core";
import type { ClaudeTurnEvent } from "@vendoai/apps/claude-turn";
import type { SyncFile, TreeState } from "../materialize.js";
import { emptyTree, inWritableMount } from "../materialize.js";
import { MESSAGE_BUDGET_MS, type SessionMachine, type SessionMessage } from "./machine.js";

/** The session runner is shared with the box — one implementation, two homes. Its
 *  OWN subpath, so importing it never drags the render seam's `./internal` in,
 *  and `./internal` never drags this in. */
const RUNNER = "@vendoai/apps/claude-turn";

/**
 * The SDK, from HERE, because this package declares the optional peer
 * (`@vendoai/apps` declares it too, for the box door) — and this function is
 * the ONLY place in the shipped packages that names it on a host path.
 *
 * `turbopackIgnore`/`webpackIgnore` keep it out of a host's BUILD: a bundler
 * that resolves this specifier refuses to build a Next.js host that has not
 * installed a ~250MB platform binary it may never run, which is precisely the
 * cost the optional peer exists to avoid. The import still happens at runtime,
 * against the deployment's own node_modules.
 */
async function loadAgentSdk(): Promise<unknown> {
  try {
    return await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "@anthropic-ai/claude-agent-sdk");
  } catch (cause) {
    // The operator, not the user: this is a deployment choice that was not
    // followed through, and it can only be fixed by installing something.
    throw new VendoError(
      "validation",
      "claudeCode({ machine: \"local\" }) needs the Claude Agent SDK on this server. "
      + "Install @anthropic-ai/claude-agent-sdk, or drop `machine: \"local\"` and give the "
      + "harness a sandbox instead, which keeps the SDK off your server entirely.",
      { cause },
    );
  }
}

/**
 * The one thing an operator who opted into `machine: "local"` has to be told,
 * said once per process — it is a deployment fact, not a per-turn event (the
 * same shape as the missing-door warning).
 *
 * Not a refusal: the mode is a documented, explicit opt-in and removing it is a
 * product decision, not this file's. But the code's own permission rationale
 * reads "the box IS the permission", and on this path there is no box, so
 * choosing it silently would let a host believe they had a boundary they do not.
 */
let localRiskWarned = false;
function warnLocalRiskOnce(): void {
  if (localRiskWarned) return;
  localRiskWarned = true;
  console.error(
    "[vendo] claudeCode({ machine: \"local\" }) runs the agent's shell on THIS server, not in a box. "
    + "Bash, Write and Edit are auto-allowed and are not confined to the workspace copy, so a user's "
    + "message — or text an app, document or tool result put in front of the model — can read and write "
    + "this server's files and reach anything this server can reach on the network. There is no egress "
    + "allowlist on this path. The agent's ENVIRONMENT is scoped (the SDK replaces it rather than "
    + "inheriting yours, so your other env secrets are not exposed), but secrets AT REST are not: it runs "
    + "as this OS user, so .env files, cloud credential files and kubeconfigs are readable. "
    + "Use the sandbox path (`claudeCode({ sandbox })`) for anything a customer talks to.",
  );
}

/** A stable home per thread, so the SDK's own session file survives between
 *  turns on the same host exactly as it survives inside a warm box. */
const homeFor = (threadId: string): string =>
  path.join(tmpdir(), "vendo-claude-code", threadId.replace(/[^A-Za-z0-9_-]/g, "_"));

/** Workspace path → disk path, and back. `/user/apps/a/app.vendo` lives at
 *  `<root>/user/apps/a/app.vendo`: one root, the frozen layout underneath. */
const toDisk = (root: string, workspacePath: string): string =>
  path.join(root, workspacePath.replace(/^\//, ""));
const toWorkspace = (root: string, diskPath: string): string =>
  `/${path.relative(root, diskPath).split(path.sep).join("/")}`;

/** `*` stands for exactly ONE segment — the box door's rule, kept identical so
 *  both machines answer the same question the same way. */
const matchesPattern = (pattern: string, workspacePath: string): boolean => {
  const wanted = pattern.split("/");
  const actual = workspacePath.split("/");
  if (wanted.length !== actual.length) return false;
  return wanted.every((segment, at) => segment === "*" || segment === actual[at]);
};

/** Every file under `directory`, in DISK paths. A directory we cannot read is
 *  simply not there — same shape as the box door's own walk. */
async function walk(directory: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** One live session per thread, for the life of the process — the local mirror of
 *  "one box per conversation". */
interface LocalSession {
  /** The live `ClaudeSession`, once the first message has opened it. */
  session?: {
    send(prompt: string): Promise<void>;
    steer(prompt: string): boolean;
    interrupt(): Promise<void>;
    end(): Promise<void>;
  };
  /** The brief the live session was OPENED with. The SDK fixes `systemPrompt`
   *  at open, so this is the only record of what the session is thinking with —
   *  and the only way to notice it has gone stale. */
  brief?: string;
  /** Has this thread's workspace been materialized in this process? */
  warm: boolean;
  /** What this thread's disk holds — the sync-back baseline, per conversation. */
  tree: TreeState;
  /**
   * The TURN currently in flight, and the only thing the session's sinks are
   * allowed to close over.
   *
   * A session outlives the turn that opened it, so capturing that turn's `emit`
   * directly sent every later turn's text to a queue nobody was draining —
   * measured live 2026-08-02: the user's second message came back completely
   * empty. The box path routes through whichever message is in flight for
   * exactly this reason; local mode does the same.
   */
  live?: Pick<SessionMessage, "emit" | "onFileWritten">;
}
const locals = new Map<string, LocalSession>();

export interface LocalMachineOptions {
  threadId: string;
  /** The recorded v0 inference exception (design §9): a harness must reach a
   *  model to think. Nothing else enters the SDK subprocess's environment. */
  env: Record<string, string>;
  /** Test seam — the real factory is loaded from {@link RUNNER}, with the SDK. */
  openSession?: (input: Record<string, unknown>) => LocalSession["session"];
  /** Test seam; production uses {@link MESSAGE_BUDGET_MS}. */
  messageBudgetMs?: number;
}

/** The sentinel the budget resolves with — a value `send()` can never produce,
 *  so "finished" and "ran out of time" stay distinguishable. */
const OUTRAN = Symbol("outran");

/**
 * `work`, or the budget — whichever lands first. `true` means the work finished.
 *
 * A rejection from `work` propagates as itself: a turn that FAILED is a fact the
 * caller already knows how to carry, and dressing it up as a timeout would lose
 * the session's own sentence. The timer is `unref`ed so an ordinary fast turn
 * never holds the process open waiting for a budget nobody needs.
 */
async function withinBudget(work: Promise<void>, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof OUTRAN>((resolve) => {
    timer = setTimeout(() => resolve(OUTRAN), budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, budget]) !== OUTRAN;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function localMachine(options: LocalMachineOptions): Promise<SessionMachine> {
  warnLocalRiskOnce();
  const home = homeFor(options.threadId);
  // STABLE per thread, not a fresh mkdtemp per turn. The SDK files its session
  // under `CLAUDE_CONFIG_DIR/projects/<slug of cwd>`, so a moving working
  // directory means `resume` looks in a project folder that has never existed —
  // measured: turn 2 of a live thread failed outright instead of remembering.
  const root = path.join(home, "workspace");
  const configDir = path.join(home, "claude");
  const held = locals.get(options.threadId) ?? { warm: false, tree: emptyTree() };
  locals.set(options.threadId, held);
  // A FRESH thread gets an emptied tree: the STORE is the truth, and
  // re-materializing from it is what makes "a different harness sees the
  // identical workspace" true. A warm thread's tree is the live session's working
  // copy and is left exactly as the last turn left it.
  if (!held.warm) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(root, { recursive: true });
    await mkdir(configDir, { recursive: true });
  }

  return {
    carriesSession: held.warm,

    pluginPath: path.join(root, "host"),

    tree: held.tree,

    // Loopback, because on this path the machine IS the host: a dev server the
    // session starts binds here, and the browser asking for the preview is on
    // the same box by definition (that is what `machine: "local"` means).
    async url(port: number) {
      return `http://127.0.0.1:${port}`;
    },

    async materialize(files) {
      for (const file of files) {
        const target = toDisk(root, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.bytes);
        // Advisory only — the sync-back seam is the real enforcement, because a
        // process running as the file's owner can always chmod it back.
        if (file.readOnly) chmodSync(target, 0o444);
      }
    },

    async collect(paths) {
      if (paths !== undefined) {
        // An entry naming a `*` segment asks by SHAPE, which is how a file that
        // did not exist at turn start reaches the mid-turn sync.
        const patterns = paths.filter((entry) => entry.includes("*"));
        let matched: string[] = [];
        if (patterns.length > 0) {
          matched = (await walk(root))
            .map((diskPath) => toWorkspace(root, diskPath))
            .filter((workspacePath) =>
              patterns.some((pattern) => matchesPattern(pattern, workspacePath)));
        }
        const found: SyncFile[] = [];
        for (const workspacePath of new Set([...paths.filter((entry) => !entry.includes("*")), ...matched])) {
          try {
            found.push({ path: workspacePath, bytes: await readFile(toDisk(root, workspacePath)) });
          } catch {
            // Not written yet. Absent is not a deletion on the hot path.
          }
        }
        return found;
      }
      const files: SyncFile[] = [];
      for (const diskPath of await walk(root)) {
        const workspacePath = toWorkspace(root, diskPath);
        // A walk of a real disk has no store to ask, so it answers the only
        // question a shape can: `/user` and `/orgs` come home, `/host` never
        // does. WHETHER a carried path may land is the sync-back seam's
        // `canCommit`, per file — the box door's own walk keeps the same rule.
        if (!inWritableMount(workspacePath)) continue;
        files.push({ path: workspacePath, bytes: await readFile(diskPath) });
      }
      return files;
    },

    async send(message: SessionMessage) {
      // Point the session's sinks at THIS turn before anything can arrive.
      held.live = {
        emit: message.emit,
        ...(message.onFileWritten === undefined ? {} : { onFileWritten: message.onFileWritten }),
      };
      // `reopen` is a TRUNCATION: the session remembers an answer the user threw
      // away, so it must not survive. It used to ALSO fire on a changed tool
      // listing, because an in-process MCP server's tool set is fixed at open;
      // the door lists live, so that reason is gone.
      //
      // A CHANGED BRIEF is the other reason, and it is not optional: the SDK
      // fixes `systemPrompt` when the session opens, so on a warm session turn
      // 1's [Situation] would BECOME the standing prompt and every later turn's
      // would be dropped — the spec's "current turn only" false on this machine.
      // Unlike a truncation this keeps the memory: `resume` rides the reopen.
      if (held.session !== undefined
        && (message.reopen === true || held.brief !== message.systemPrompt)) {
        const closing = held.session;
        held.session = undefined;
        await closing.end().catch(() => undefined);
      }
      if (held.session === undefined) {
        const createClaudeSession = options.openSession
          ?? (await import(RUNNER)).createClaudeSession as (input: Record<string, unknown>) => LocalSession["session"];
        const sdk = options.openSession === undefined ? await loadAgentSdk() : undefined;
        held.session = createClaudeSession({
          systemPrompt: message.systemPrompt,
          model: message.model,
          effort: message.effort,
          maxTurns: message.maxTurns,
          ...(message.resume === undefined ? {} : { resume: message.resume }),
          ...(message.pluginPath === undefined ? {} : { pluginPath: message.pluginPath }),
          ...(message.skillNames === undefined ? {} : { skillNames: message.skillNames }),
          ...(message.toolDoor === undefined ? {} : { toolDoor: message.toolDoor }),
          cwd: root,
          // CLAUDE_CONFIG_DIR is the whole handoff: the SDK reads it from the
          // environment, so the runner is told nothing about where the session lands.
          env: { ...options.env, CLAUDE_CONFIG_DIR: configDir },
          // STABLE indirections, never this turn's closures: the session
          // outlives the turn that opened it (see LocalSession.live). Between
          // turns nothing is in flight, and anything arriving then is dropped
          // rather than attributed to the next turn.
          emit: (event: ClaudeTurnEvent) => held.live?.emit(event),
          onFileWritten: (written: string | undefined) => held.live?.onFileWritten?.(written),
          ...(sdk === undefined ? {} : { sdk }),
        });
        held.brief = message.systemPrompt;
      }
      held.warm = true;
      if (message.signal?.aborted === true) {
        await held.session!.interrupt();
        return;
      }
      const stop = message.signal === undefined
        ? undefined
        : () => void held.session?.interrupt().catch(() => undefined);
      if (stop !== undefined) message.signal!.addEventListener("abort", stop, { once: true });
      const running = held.session!;
      try {
        const sending = running.send(message.prompt);
        if (!await withinBudget(sending, options.messageBudgetMs ?? MESSAGE_BUDGET_MS)) {
          // A turn that outran its budget is one nobody can reason about any
          // more — and it is not just this turn at stake. `ClaudeSession` answers
          // pushed messages in order, so a `send()` left pending holds every
          // later turn on this thread behind it: the user's next message would
          // wait on a turn that already lost, silently, for the life of the
          // process. So the SESSION goes, not just the turn. The disk stays warm
          // (files and the SDK's own session file are still there), which makes
          // the next message a fresh session that resumes rather than a cold
          // start — the same recovery the box path takes when its box is gone.
          void sending.catch(() => undefined);
          await running.interrupt().catch(() => undefined);
          if (held.session === running) held.session = undefined;
          // Fire and forget on purpose: `end()` waits on the SDK's own loop, and
          // waiting on the loop we just declared stuck is how one hang becomes
          // two.
          void running.end().catch(() => undefined);
          throw new VendoError(
            "sandbox-unavailable",
            "the local session's message outran its budget",
          );
        }
      } finally {
        if (stop !== undefined) message.signal!.removeEventListener("abort", stop);
        // The turn is over; nothing may be attributed to it from here on.
        held.live = undefined;
      }
    },

    async steer(prompt: string) {
      // No hop: the live session IS in this process. It refuses when no turn is
      // in flight, which is the same answer the box door gives — one rule, two
      // homes, exactly like `send`.
      return held.session?.steer(prompt) === true;
    },

    async release() {
      // Nothing to tear down: the session and its config dir deliberately stay,
      // which is what makes the next message a push rather than a cold start.
    },
  };
}

/** Test + shutdown seam: end every local session this process holds. */
export async function disposeLocalSessions(): Promise<void> {
  const held = [...locals.values()];
  locals.clear();
  for (const entry of held) await entry.session?.end().catch(() => undefined);
}
