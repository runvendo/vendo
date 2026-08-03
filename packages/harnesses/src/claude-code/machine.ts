/**
 * The machine a `claudeCode()` conversation lives on — the port both drivers
 * implement.
 *
 * The whole difference between `machine: "local"` and the sandbox path is behind
 * this interface: where the workspace copy lands, and how the live SDK session is
 * reached. Everything above it (checkout, the diff sync-back, the guarded
 * projection, `turn.state`) is shared, which is what stops the opt-in from being
 * a second implementation of the same harness.
 *
 * cc-native shape: a machine holds ONE session for the whole conversation, so
 * `send()` replaces the old per-turn `run()`. A machine is either FRESH (just
 * created — materialize it and re-seed the thread from our transcript) or WARM
 * (its disk already carries both the files and the native session).
 */
import type { ClaudeTurnEvent } from "@vendoai/apps/claude-turn";
import type { CheckoutFile, SyncFile, TreeState } from "../materialize.js";

/** What opening a session needs. Fixed for the life of the session.
 *
 *  `tools` is deliberately absent: the session reaches the host's tools through
 *  the MCP door (`toolDoor`), which LISTS them live, so there is no snapshot to
 *  keep in step and no reopen when the equipped set changes. */
export interface SessionOpen {
  systemPrompt?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  /** The native session to continue (`turn.state`), on a disk that holds it. */
  resume?: string;
  /** The local plugin root carrying `skills/<name>/SKILL.md` — our `/host` mount. */
  pluginPath?: string;
  /** Exactly which skills to enable, by name — OURS, never "all" (which would
   *  also enable whatever the machine's own home directory carries). */
  skillNames?: readonly string[];
  /**
   * The host's MCP door and this conversation's credential — the ONLY way
   * anything reaches the world (10-mcp §3b).
   *
   * Absent means the session runs with the machine's own hands only. A BOX gets
   * there only by refusal — `claudeCode()` will not open a session against a
   * door it knows the box cannot reach. A LOCAL machine does run that way, and
   * the operator is warned once, because a subprocess on this host with no
   * origin to dial is a workspace-only assistant rather than a broken box.
   */
  toolDoor?: { url: string; token: string };
}

export interface SessionMessage extends SessionOpen {
  prompt: string;
  /**
   * Close the live session before answering, and open a fresh one that resumes
   * NOTHING.
   *
   * Set on a detected prefix truncation (§1.3): the session is holding an answer
   * the user threw away, so continuing it would have the model remember what was
   * deleted. The prompt then carries the full re-seed from our transcript.
   */
  reopen?: boolean;
  emit: (event: ClaudeTurnEvent) => void;
  /** A file the turn wrote, from the SDK's native PostToolUse hook. `undefined`
   *  means a write whose path we cannot know (`Bash`). */
  onFileWritten?: (path: string | undefined) => void;
  signal?: AbortSignal;
}

export interface SessionMachine {
  /**
   * Does this machine's disk already hold the native session AND the workspace?
   *
   * False for a machine that was just created — a first message, or a recovery
   * after the box died. The harness then materializes the checkout and re-seeds
   * the thread from OUR transcript instead of asking the SDK to resume a session
   * no disk holds, which fails the turn outright.
   */
  readonly carriesSession: boolean;
  /**
   * Where the `/host` mount lands on THIS machine's disk — which is also the
   * SDK plugin root, because `hostSkillFiles` already writes
   * `/host/skills/<name>/SKILL.md` and the SDK reads
   * `<pluginPath>/skills/<name>/SKILL.md`. Same layout, so the mount IS the
   * plugin. The machine owns it because the machine owns the disk layout.
   */
  readonly pluginPath: string;
  /**
   * What this machine's disk is known to hold, persisted across the turns of one
   * conversation. A warm machine is never re-materialized, so this — not a fresh
   * store read — is what turn-end sync diffs against. See `TreeState`.
   */
  readonly tree: TreeState;
  /** Land the checkout on this machine's disk. `/host` lands read-only. */
  materialize(files: readonly CheckoutFile[]): Promise<void>;
  /**
   * Read the workspace back, in WORKSPACE paths. `paths` narrows the read to the
   * hot set; omitted, it is the whole writable tree — which is what makes
   * deletions visible at turn end.
   *
   * A `paths` entry may name a `*` segment (`/user/apps/&#42;/plan.vendo`), matching
   * exactly one segment. That is the only way a file the turn INVENTED — a plan
   * for an app whose id did not exist when the conversation started — reaches the
   * hot sync, and it is matched machine-side so the wire carries the hot files
   * only.
   */
  collect(paths?: readonly string[]): Promise<SyncFile[]>;
  /** Push one user message into the live session and settle when its turn ends. */
  send(message: SessionMessage): Promise<void>;
  /**
   * The turn is over. Local keeps its session for the next turn; the sandbox path
   * keeps the box warm on an idle timer and destroys it when that expires.
   */
  release(): Promise<void>;
}
