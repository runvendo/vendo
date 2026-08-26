/**
 * The sandbox path — ONE box per conversation, holding ONE live session.
 *
 * **What this file used to be.** A machine POOL with an idle sweep that
 * SNAPSHOTTED before destroying, a resume-ref threaded through `turn.state`, and
 * a token-rotation handshake to re-authenticate a woken supervisor — about 200
 * lines of machinery whose entire purpose was to make a cold start per message
 * cheap. A live session has no cold start per message, so none of it is needed:
 * the box stays up for the conversation and is DESTROYED when it goes idle.
 * A conversation that outlives its box recovers the honest way — a fresh box,
 * files re-materialized from the store, the thread re-seeded from our transcript.
 *
 * That trade is deliberate and it is the cheaper one: a snapshot bought us a
 * resumable session id at the cost of a resume-ref, a rotation protocol, and two
 * race windows. Re-materializing from the store — which is the truth anyway —
 * costs one round trip on the rare message that finds its box gone.
 *
 * **The bridge is GONE.** `SandboxMachine.request()` used to be the only runtime
 * data path INTO the box, so the host drove: it posted a message, then polled;
 * when the model reached a projected tool the box parked the ask and handed it
 * out on the next poll; the host ran `turn.tools.call()` and posted the answer
 * back. cc-native MEASURED whether our MCP door could replace that and it could
 * not; door-ctx made it (10-mcp §3b), so the box now reaches the host's tools
 * directly over remote MCP with a credential scoped to the turn in flight.
 *
 * The poll loop stays — it is how text, usage and `wrote` events leave the box —
 * but it no longer carries asks, and there is no `/answer` route.
 *
 * **§1.4, and a cost the flip introduced.** A guarded call may block up to
 * `APPROVAL_WAIT_MS` for a human tap. That wait used to happen HERE, where the
 * host could arm the idle timer across it so a wait outliving the idle budget
 * lost the box. It now happens inside the door, on the host, and from out here
 * it is indistinguishable from a slow tool — so the box IS held for that window
 * (bounded by `MESSAGE_BUDGET_MS`). Better for the user (an approved call
 * resumes on the same session) and worse for cost (a parked write holds a
 * sandbox for up to 90s). Recorded in the lane's close note as a deviation.
 */
import { isVendoError, log, VENDO_DEV_PORT, VENDO_DEV_PORT_ENV, VendoError, WARM_THREAD_PREFIX } from "@vendoai/core";
import type { CheckoutFile, SyncFile, TreeState } from "../materialize.js";
import { emptyTree } from "../materialize.js";
import { MESSAGE_BUDGET_MS, type SessionMachine, type SessionMessage } from "./machine.js";

/** The subset of `SandboxAdapter` (`@vendoai/apps`) a session box needs.
 *  Structural so this subpath never widens the package's type surface.
 *
 *  `snapshot` is deliberately absent now: nothing snapshots a conversation box. */
export interface SandboxAdapterLike {
  create(spec: { template?: string; env: Record<string, string>; allowedDomains?: string[] }): Promise<SandboxMachineLike>;
  destroy(snapshotRef: string): Promise<void>;
}
export interface SandboxMachineLike {
  id: string;
  request(req: { method: string; path: string; port?: number; headers?: Record<string, string>; body?: Uint8Array | string }):
    Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  /** The box's filesystem, as `SandboxMachine.files` defines it: read rejects
   *  for a path the box does not hold, write replaces whole, list is one level
   *  and names only. */
  files: {
    read(path: string): Promise<Uint8Array>;
    write(path: string, bytes: Uint8Array | string): Promise<void>;
    list(dir: string): Promise<string[]>;
  };
  /** The machine's PUBLIC ingress URL for a port — the browser→box path, which
   *  `request()` (host→box) cannot stand in for. Declared exactly as
   *  `SandboxMachine.url` so a real adapter still satisfies this narrowing. */
  url(port?: number): Promise<string>;
  destroy(): Promise<void>;
}

/** The supervisor's control port, as `box-agent.ts` names it. */
const CONTROL_PORT = 8811;
/**
 * Where the host's workspace is mounted ON THE BOX'S DISK. The session door
 * maps every workspace path the host speaks onto this root (`toDisk`,
 * `box/turn-routes.mjs`) and opens the in-box session with it as `cwd`.
 *
 * Exported because anything a PROMPT sends the in-box agent to has to be spelled
 * from here: the agent has a shell, so it reads a bare `/user/apps/<id>` as the
 * filesystem root and writes where `collect` never looks.
 */
export const BOX_WORKSPACE_ROOT = "/workspace";
/** How long a box may sit between messages before it is destroyed. */
export const BOX_IDLE_TTL_MS = 5 * 60_000;
/** The box holds each poll open this long before answering empty. */
const POLL_WAIT_MS = 10_000;
/**
 * How long the workspace seam may still be trying.
 *
 * The box parks the model behind its own write for `SYNC_ACK_WAIT_MS` (25s,
 * `box/turn-routes.mjs`) waiting for this host to say the sync landed, and then
 * tells the model it did not. A replay that starts after that window is
 * answering a question nobody is waiting on any more, over a model that has
 * already been told the opposite — so the replay is refused past the window, and
 * cut loose the moment it reaches it. The FIRST attempt still runs on the
 * adapter's own timeout, which this seam does not own.
 *
 * The twin of `SYNC_ACK_WAIT_MS` in `box/turn-routes.mjs`, which cannot import it:
 * that module ships inside the machine image and stays dependency-free. The two
 * literals are held equal by `tests/claude-code/box-sync-window.test.ts`, which
 * reads both files — drift between them is a red test, not a silent race.
 */
const WORKSPACE_RETRY_WINDOW_MS = 25_000;

/** Rejects when the window closes. The call underneath cannot be CANCELLED from
 *  here — this seam takes no signal — but it can stop being waited on, and what
 *  it may still do late is bounded: a materialize chunk is refused by its
 *  generation or rewrites its own bytes, and a collect is a read nobody reads. */
const expire = (ms: number, path: string): Promise<never> =>
  new Promise((_resolve, reject) => {
    const timer = setTimeout(
      () => reject(new VendoError("sandbox-unavailable", `box ${path} did not answer inside the ${WORKSPACE_RETRY_WINDOW_MS}ms sync window`)),
      ms,
    );
    timer.unref?.();
  });

/**
 * A fault that carries NO answer — the connection died, so whether the box
 * applied the call is exactly what we do not know, which is the only state a
 * replay can improve. The adapters mark it by hanging the reason on
 * `detail.cause` (`cloudSandbox`'s `send`); an answer they merely disliked —
 * 401, 402, 429, a destroyed machine — carries none. An unclassified throw from
 * a BYO adapter is transport by default: raw is what a dead socket looks like.
 */
const dropped = (error: unknown): boolean =>
  !isVendoError(error)
  || (error.code === "sandbox-unavailable" && (error.detail as { cause?: unknown } | undefined)?.cause !== undefined);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface BoxEntry {
  machine: SandboxMachineLike;
  /** Minted once, at create. There is no rotation: a box is never restored from
   *  a snapshot, so no supervisor ever comes back holding a stale token. */
  token: string;
  /** Has this box been materialized and had its session opened? */
  warm: boolean;
  /** Set on a CLAIMED spare, whose disk carries the warm probe's live session:
   *  the next message must close it and open one that resumes nothing. */
  reopen: boolean;
  /** What this box's disk holds — the sync-back baseline, per conversation. */
  tree: TreeState;
  /** The materialize GENERATION this host has minted for this box, counted up
   *  before each upload so a replay always outranks the attempt it replaces.
   *  The box reports what it holds (`hello`, `collect`); a box reporting less
   *  than this is not holding the disk this host wrote. */
  epoch: number;
  idle?: ReturnType<typeof setTimeout>;
}

/** One box per THREAD, for as long as the conversation stays warm — plus, under
 *  the spare key below, the box a WARM turn booted, waiting to be claimed.
 *  Module-scoped because that is what "the box outlives the turn" means. */
const boxes = new Map<string, BoxEntry>();

const mintToken = (): string => `bxt_${globalThis.crypto.randomUUID()}`;

async function control(
  machine: SandboxMachineLike,
  token: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const answer = await machine.request({
    method: "POST",
    path,
    port: CONTROL_PORT,
    headers: {
      "content-type": "application/json",
      // The box refuses any /session route without it: the ONE thing the machine
      // holds besides a workspace copy and the inference key.
      "x-vendo-box-token": token,
    },
    ...(body === undefined ? {} : { body: encoder.encode(JSON.stringify(body)) }),
  });
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(answer.body));
  } catch {
    json = undefined;
  }
  return { status: answer.status, json };
}

/** Nothing may be destroyed under a box that is about to be used. */
function disarmIdle(entry: BoxEntry): void {
  if (entry.idle !== undefined) clearTimeout(entry.idle);
  entry.idle = undefined;
}

/** Arm the idle timer: destroy, full stop. No snapshot, nothing to publish — the
 *  store already holds every file, and the transcript already holds the thread. */
function armIdle(threadId: string, entry: BoxEntry, idleTtlMs: number): void {
  disarmIdle(entry);
  entry.idle = setTimeout(() => {
    // A timer can outlive its entry (an eviction). Without this it would destroy
    // whichever box holds the slot NOW.
    if (boxes.get(threadId) !== entry) return;
    boxes.delete(threadId);
    void entry.machine.destroy().catch(() => undefined);
  }, idleTtlMs);
  entry.idle.unref?.();
}

export interface BoxMachineOptions {
  sandbox: SandboxAdapterLike;
  threadId: string;
  env: Record<string, string>;
  /**
   * The outbound-domain allowlist this box boots with, filtered at the
   * PROVIDER's domain layer. Required, and never optional: the seam reads
   * `allowedDomains: undefined` as UNRESTRICTED egress (`SandboxAdapter.create`
   * in `@vendoai/apps`), so a caller that simply forgot would hand a box driven
   * by user text an unfiltered internet. Unnamed must mean denied for a
   * network boundary, even now that the box's own TOOLS run unprompted (the
   * box is the permission; this list is part of what makes that true). An
   * empty list is the strictest policy expressible here.
   *
   * "Strictest expressible" is not "airtight": the provider's filter keys on the
   * requested server name, so a client that omits SNI is not matched and is let
   * through (measured; not closable from this side).
   */
  allowedDomains: string[];
  /** Provider template; defaults to `VENDO_BOX_TEMPLATE`. */
  template?: string;
  /** Test seam; production uses {@link BOX_IDLE_TTL_MS}. */
  idleTtlMs?: number;
  /** Test seam; production uses {@link MESSAGE_BUDGET_MS}. Same seam the local
   *  rung carries, so neither rung's budget can be exercised only in theory. */
  messageBudgetMs?: number;
}

export async function boxMachine(options: BoxMachineOptions): Promise<SessionMachine> {
  const idleTtlMs = options.idleTtlMs ?? BOX_IDLE_TTL_MS;
  const template = options.template ?? globalThis.process?.env?.["VENDO_BOX_TEMPLATE"];

  // Where a WARM turn parks its box. Not under its thread id: `WARM_THREAD_PREFIX`
  // says that id dies with the one-token probe, so a box parked under it is a real
  // cloud machine — booted, hello'd, billed for the whole idle TTL — that the
  // conversation it was warmed FOR can never find. That turn arrives under its own
  // thread id, misses, and boots a second box, which is the entire cost the warm
  // door exists to remove.
  //
  // The key is the CREATE SPEC, because that is what makes a spare interchangeable
  // with the box a real turn would have booted. `\0` cannot appear in a thread id,
  // so no conversation collides with it. `env` is deliberately not part of it: the
  // claimer's own env lands on the box through the `hello` that claims it.
  const spare = `\0spare ${JSON.stringify([template ?? null, options.allowedDomains])}`;
  const warming = options.threadId.startsWith(WARM_THREAD_PREFIX);
  const key = warming ? spare : options.threadId;

  /**
   * The credential handoff, and the only one. The box trusts the first hello
   * while it is unclaimed and refuses every other caller after.
   *
   * CLAUDE_CONFIG_DIR is deliberately unset: the SDK's default lives under $HOME,
   * and `/workspace` is the materialized copy — parking the native session there
   * would put machine state inside the user's files.
   *
   * The answer carries the box's own materialize generation, which is how a
   * RESTARTED supervisor is told from the box it is wearing the name of: same
   * machine, same token, empty disk, generation back at zero. `undefined` is a
   * box that did not answer at all; an answer with no generation is a box image
   * that predates it and can therefore say nothing wrong about it.
   */
  const hello = async (machine: SandboxMachineLike, token: string): Promise<{ epoch?: number } | undefined> => {
    const { status, json } = await control(machine, token, "/session/hello", {
      token,
      env: options.env,
    }).catch(() => ({ status: 0, json: undefined }));
    if (status !== 200) return undefined;
    const epoch = (json as { epoch?: unknown } | undefined)?.epoch;
    if (typeof epoch === "number") return { epoch };
    // Tolerated, and therefore said out loud: for the length of the rollout every
    // guard below reads "no generation" as "nothing to disagree with" and passes,
    // so an unprotected turn is otherwise indistinguishable from a protected one.
    log({
      code: "harnesses.claude-code-box-no-generation",
      level: "warn",
      message: "[vendo] claude-code: the box reports no workspace generation — its image predates the guard, so nothing this turn reads back is checked against what it wrote. Rebake the box image.",
    });
    return {};
  };

  const bootBox = async (): Promise<BoxEntry> => {
    const token = mintToken();
    const machine = await options.sandbox.create({
      ...(template === undefined ? {} : { template }),
      env: {
        ...options.env,
        VENDO_BOX_TOKEN: token,
        VENDO_WORKSPACE_ROOT: BOX_WORKSPACE_ROOT,
        // The dev port is DECLARED here, at create, from the same core constant
        // the template's vite config resolves. A preview URL is minted from it
        // before the dev server has necessarily booted, so it can never be
        // discovered post-boot — and a second literal is how the two drift.
        [VENDO_DEV_PORT_ENV]: String(VENDO_DEV_PORT),
      },
      allowedDomains: [...options.allowedDomains],
    });
    if (await hello(machine, token) === undefined) {
      await machine.destroy().catch(() => undefined);
      throw new VendoError(
        "sandbox-unavailable",
        "the workspace machine refused the session handshake",
      );
    }
    const fresh: BoxEntry = { machine, token, warm: false, reopen: false, tree: emptyTree(), epoch: 0 };
    boxes.set(key, fresh);
    return fresh;
  };

  /** Take the box parked at `at`, if it is still there.
   *
   *  PROBE, never assume. A box can be gone without us having asked — a provider
   *  reap, an idle policy on their side, a host that slept. Handing that corpse
   *  out made the thread fail in a third of a second for the whole process
   *  lifetime; only a restart recovered it. `hello` re-presenting the SAME token
   *  is the cheapest round trip the box answers, and on a spare it doubles as the
   *  claimer's env handoff.
   *
   *  `exclusive` empties the slot BEFORE that probe awaits — what a claim needs
   *  and a thread key must not have. Two first messages arriving inside one hello
   *  round trip would otherwise both be handed the same spare, and two
   *  conversations would share one disk and one session. */
  const adopt = async (at: string, exclusive = false): Promise<BoxEntry | undefined> => {
    const held = boxes.get(at);
    if (held === undefined) return undefined;
    if (exclusive) boxes.delete(at);
    disarmIdle(held);
    // A box that answers is not yet a box that still HOLDS what we put on it: a
    // restarted supervisor answers every route with an empty disk, and `warm` is
    // our memory of it rather than its state. The generation it reports is the
    // one thing it cannot be wrong about.
    const greeted = await hello(held.machine, held.token);
    if (greeted !== undefined && (greeted.epoch ?? held.epoch) >= held.epoch) return held;
    log({
      code: "harnesses.claude-code-box-stale",
      level: "error",
      message: `[vendo] claude-code: the box ${greeted === undefined ? "stopped answering" : "no longer holds the workspace"}; starting fresh`,
    });
    boxes.delete(at);
    await held.machine.destroy().catch(() => undefined);
    return undefined;
  };

  const startedAt = Date.now();
  let served: "thread-reuse" | "spare-claim" | "cold-boot" = "thread-reuse";
  let entry = await adopt(key);
  // THE CLAIM. A spare's disk holds the probe's workspace and its live session,
  // neither of which is this conversation's, so it is handed over as a FRESH box
  // is — `warm: false` and an empty tree, which is what makes the caller
  // materialize and re-seed — plus the one thing a fresh box does not need:
  // `reopen`, because the probe's session is live on that disk and must not be
  // what the user's first message continues.
  //
  // Claimable only while PARKED, and an armed idle timer is exactly that fact:
  // the warm turn ended and the box is waiting to be reaped. One still mid-probe
  // is left alone — both turns would materialize over each other on the one disk.
  if (entry === undefined && !warming && boxes.get(spare)?.idle !== undefined) {
    entry = await adopt(spare, true);
    if (entry !== undefined) {
      served = "spare-claim";
      boxes.set(key, entry);
      entry.warm = false;
      entry.reopen = true;
      entry.tree = emptyTree();
    }
  }
  if (entry === undefined) served = "cold-boot";
  entry ??= await bootBox();
  const box = entry;
  // The one number that says whether warming is working: a cold boot here is a
  // second of the user's first message, a claim is none of it.
  log({
    code: "harnesses.claude-code-box-ready",
    level: "debug",
    message: `[vendo] claude-code: box ready by ${served} in ${Date.now() - startedAt}ms`,
  });

  /**
   * `repeatable` is the caller's promise that this call is the same twice — the
   * workspace seam is (the same bytes to the same path; a read), a call that
   * starts work is not. Only those may be replayed, because a transport fault
   * carries no answer: whether the box applied the call is exactly what we do
   * not know. The replay is instant — what died was a connection, not a quota.
   */
  const request = async (
    path: string,
    body?: unknown,
    repeatable = false,
  ): Promise<Record<string, unknown>> => {
    const call = (): Promise<{ status: number; json: unknown }> =>
      control(box.machine, box.token, path, body);
    const started = Date.now();
    const { status, json } = await call()
      .catch((error: unknown) => {
        // A DROPPED call is the only one worth sending again, and only while
        // someone is still waiting for it. Replaying everything replayed the
        // answers too — a meter refusal, a rejected key, a machine the provider
        // destroyed — and threw the first error away to say the second one twice.
        const left = WORKSPACE_RETRY_WINDOW_MS - (Date.now() - started);
        if (!repeatable || !dropped(error) || left <= 0) throw error;
        log({
          code: "harnesses.claude-code-box-retried",
          level: "warn",
          message: `[vendo] claude-code: box ${path} dropped its connection; sending it again`,
          data: { error },
        });
        // What is LEFT of the window, not a fresh one: a first attempt that died
        // at 24s leaves a second one a second, or the pair outlasts the wait the
        // box has already given up on and holds the turn for the adapter's timeout.
        return Promise.race([call(), expire(left, path)]);
      })
      // `hello` reads a transport fault as "the box did not answer" and moves on;
      // a call somebody is waiting on has to SAY so, in this file's own voice —
      // undici's bare `TypeError: fetch failed` names neither the box nor Vendo.
      // An adapter that already named its own failure keeps its SENTENCE (the
      // wire gate shows some of them to a user verbatim) and gains the route it
      // died on, which the bare rethrow dropped.
      .catch((cause: unknown) => {
        if (isVendoError(cause)) throw new VendoError(cause.code, cause.message, { path, cause });
        throw new VendoError("sandbox-unavailable", `box ${path} could not be reached`, { cause });
      });
    if (status !== 200 && status !== 202) {
      // Carry the box's own sentence: a bare status turns every box problem
      // into a guessing game on the host side.
      const detail = (json as { error?: unknown } | undefined)?.error;
      throw new VendoError(
        "sandbox-unavailable",
        `box ${path} answered ${status}${typeof detail === "string" ? `: ${detail}` : ""}`,
      );
    }
    return (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  };

  /** The message this box is answering, for as long as it is answering it — the
   *  only thing a steer can be addressed to. */
  let inFlight: string | undefined;

  return {
    // A warm box carries BOTH the materialized files and the live session.
    carriesSession: box.warm,

    // The frozen layout (§3.1) one level under the box's root.
    pluginPath: `${BOX_WORKSPACE_ROOT}/host`,

    tree: box.tree,

    async url(port: number) {
      return await box.machine.url(port);
    },

    async materialize(files: readonly CheckoutFile[]) {
      // Minted BEFORE the first chunk and carried on every one of them, because
      // a host leg that timed out does not cancel the console→box hop behind it:
      // a dead attempt's chunk 0 can land after its replay and after the chunks
      // that followed. The box refuses a generation it has moved past and resets
      // once per generation rather than once per request, so the replay rewrites
      // its own bytes instead of wiping the ones behind it. Counted up even when
      // the upload fails, so the next attempt always outranks the stalled one.
      const epoch = (box.epoch += 1);
      // Chunked by COUNT, which bounds the typical upload body — not a hard
      // byte bound: one large file still travels alone in its chunk, and a
      // BYO files adapter can hold files the proxy may refuse.
      const CHUNK = 24;
      for (let at = 0; at < files.length; at += CHUNK) {
        await request("/session/workspace", {
          epoch,
          reset: at === 0,
          files: files.slice(at, at + CHUNK).map((file) => ({
            path: file.path,
            readOnly: file.readOnly,
            base64: Buffer.from(file.bytes).toString("base64"),
          })),
        }, true);
      }
      if (files.length === 0) await request("/session/workspace", { epoch, reset: true, files: [] }, true);
    },

    async collect(paths) {
      const answer = await request("/session/collect", paths === undefined ? {} : { paths }, true);
      // The disk this reads has to be the disk this host wrote. A supervisor that
      // restarted under the same name answers every route holding nothing, and an
      // empty read is what the sync-back turns into deleting the workspace. A box
      // image that predates the generation reports none — it can say nothing about
      // it, and nothing wrong about it either.
      const held = answer["epoch"];
      if (typeof held === "number" && held !== box.epoch) {
        throw new VendoError(
          "sandbox-unavailable",
          `box holds workspace generation ${held}, not the ${box.epoch} this turn put there`,
        );
      }
      const files = Array.isArray(answer["files"]) ? answer["files"] : [];
      return files.flatMap((raw): SyncFile[] => {
        const entryFile = raw as { path?: unknown; base64?: unknown };
        if (typeof entryFile.path !== "string" || typeof entryFile.base64 !== "string") return [];
        return [{ path: entryFile.path, bytes: new Uint8Array(Buffer.from(entryFile.base64, "base64")) }];
      });
    },

    async send(message: SessionMessage) {
      const started = await request("/session/message", {
        prompt: message.prompt,
        systemPrompt: message.systemPrompt,
        model: message.model,
        effort: message.effort,
        maxTurns: message.maxTurns,
        resume: message.resume,
        // A claimed spare's live session is the warm probe's. Closing it and
        // opening one that resumes nothing is what makes this message the user's
        // FIRST rather than the probe's second.
        reopen: message.reopen === true || box.reopen,
        pluginPath: message.pluginPath,
        skillNames: message.skillNames,
        toolDoor: message.toolDoor,
      });
      // From here on the box holds a session, so a next message on this thread
      // neither re-materializes nor re-seeds.
      box.warm = true;
      box.reopen = false;
      const messageId = String(started["messageId"] ?? "");
      // Addressable from here until the poll loop lets go: a steer names the
      // MESSAGE, and only the one being answered can take it.
      inFlight = messageId;
      const budgetMs = options.messageBudgetMs ?? MESSAGE_BUDGET_MS;
      const deadline = Date.now() + budgetMs;
      let cursor = 0;
      /** A hot sync that FAILED, owed to the box on the next poll. The ack and its
       *  failure travel the same way, so a parked write learns the sync did not
       *  happen instead of waiting out its whole bound and proceeding as if it had. */
      let syncError: string | undefined;

      // Interrupt the TURN, not the conversation — and do it the moment Stop is
      // pressed. The door parks a poll for POLL_WAIT_MS when the box has nothing
      // to say (a long tool call), so noticing the signal only between polls left
      // Stop up to ten seconds late. Same shape as the local sibling.
      let stopped = false;
      const stop = () => {
        stopped = true;
        void request(`/session/${messageId}/interrupt`, {}).catch(() => undefined);
      };

      try {
        // A signal that is already aborted never fires the event.
        if (message.signal?.aborted === true) {
          await request(`/session/${messageId}/interrupt`, {}).catch(() => undefined);
          return;
        }
        message.signal?.addEventListener("abort", stop, { once: true });
        for (;;) {
          // The listener has already interrupted; this only ends the loop.
          if (stopped) return;
          if (Date.now() > deadline) {
            await request(`/session/${messageId}/interrupt`, {}).catch(() => undefined);
            // NOT `sandbox-unavailable`: that code is this file's answer for a
            // machine that refused the handshake or a control port that stopped
            // answering, and a turn which merely ran long shares neither cause.
            // Sending an operator to inspect a healthy box is a bug of its own.
            throw new VendoError(
              "unavailable",
              `the turn outran its ${budgetMs}ms message budget`,
            );
          }
          const polled = await request(`/session/${messageId}/poll`, {
            cursor,
            waitMs: POLL_WAIT_MS,
            ...(syncError === undefined ? {} : { syncError }),
          });
          syncError = undefined;
          for (const event of Array.isArray(polled["events"]) ? polled["events"] : []) {
            const named = event as { type?: unknown; path?: unknown };
            // `wrote` is the native PostToolUse hook coming home. It is NOT a
            // HarnessEvent — it is the signal that replaced the 1.2s file-watch
            // timer, so it goes to the hot-sync callback and never to the user.
            if (named.type === "wrote") {
              try {
                await message.onFileWritten?.(typeof named.path === "string" ? named.path : undefined);
              } catch (error) {
                syncError = error instanceof Error ? error.message : String(error);
              }
              continue;
            }
            message.emit(event as never);
          }
          cursor = typeof polled["cursor"] === "number" ? polled["cursor"] : cursor;

          if (polled["done"] === true) return;
        }
      } finally {
        message.signal?.removeEventListener("abort", stop);
        inFlight = undefined;
      }
    },

    async steer(prompt: string) {
      if (inFlight === undefined) return false;
      // The box answers whether the words LANDED. A box that has gone away
      // answers nothing, which is the same fact from the user's side: their
      // message did not reach this build, so the host's queue keeps it.
      const answer = await request(`/session/${inFlight}/steer`, { prompt }).catch(() => undefined);
      return answer?.["landed"] === true;
    },

    async release() {
      // The box stays up for the next message and is destroyed when the
      // conversation goes quiet. Nothing to carry in `turn.state`: recovery is a
      // fresh box plus the store, not a snapshot ref.
      armIdle(key, box, idleTtlMs);
    },
  };
}

/* ─── what a box is BOOTED with ──────────────────────────────────────────────
   Its model door and its network boundary, beside the pool that hands them to
   the provider. They live here rather than in `claude-code/index.ts` because
   composition needs them WITHOUT the driver: that module reaches the Agent SDK
   (through `local.ts`'s dynamic import), which does not bundle for a Worker
   target, and the umbrella's server entry has to. Re-exported from there, so
   the names a host knows have not moved. */

/**
 * Every env var the Agent SDK reads a MODEL ID from — the default, the small/fast
 * step, subagent spawns, and the four family aliases.
 *
 * Taken from the SDK's own model-env array (`_Ne` in `sdk.mjs`,
 * `@anthropic-ai/claude-agent-sdk@0.3.214`) rather than guessed. The rest of that
 * array is display metadata (`_NAME`, `_DESCRIPTION`,
 * `_SUPPORTED_CAPABILITIES`) and `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION`, none of
 * which name a model to ask for.
 *
 * Pinning the default alone is what shipped, and it was not enough: a step on any
 * other slot asked the Cloud gateway for the SDK's built-in `claude-opus-4-8` and
 * the `400 Unknown model id` reached an end user's chat verbatim.
 */
const SDK_MODEL_SLOT_ENV = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
] as const;

/**
 * The recorded v0 inference exception (design §9): a boxed harness must reach a
 * model to think, and that is the ONLY credential in the machine.
 *
 * SELECTION LAW, the same one `boxInference()` in the umbrella obeys: the
 * explicit VENDO_INFERENCE_URL+KEY pair — which is what the box env door sets —
 * wins; otherwise VENDO_API_KEY funds the box's model through the console's
 * Anthropic-compatible gateway at `<console>/api/v1`; otherwise the box gets no
 * inference credential at all.
 *
 * A stray ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL selects NOTHING. It used to
 * outrank both rungs, so a provider key sitting in the deployment's environment
 * silently decided which account every box billed. Naming an own endpoint is
 * still fully supported — as the explicit pair, which is config.
 */
export function inferenceEnv(): Record<string, string> {
  const source = globalThis.process?.env ?? {};
  const set = (name: string): string | undefined => {
    // Trimmed, because a blank line in a `.env` is the same misconfiguration as
    // an empty one — and taking it as a credential boots a configured box whose
    // every call comes back 401.
    const value = source[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const env: Record<string, string> = {
    // Nothing the CLI reaches for on the side: its telemetry and update hosts are
    // not on the box's allowlist (`boxEgress` below), so those calls fail rather
    // than answer — and a stalled one is a hung turn.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  // The PAIR, both halves or neither: half an endpoint is a misconfiguration, and
  // quietly completing it from somewhere else is how a box ends up billing an
  // account nobody chose.
  const pairKey = set("VENDO_INFERENCE_KEY");
  const pairUrl = set("VENDO_INFERENCE_URL");
  const cloudKey = set("VENDO_API_KEY");
  let key: string | undefined;
  let url: string | undefined;
  if (pairKey !== undefined && pairUrl !== undefined) {
    key = pairKey;
    url = pairUrl;
  } else if (cloudKey !== undefined) {
    const base = (set("VENDO_CLOUD_URL") ?? "https://console.vendo.run").replace(/\/+$/, "");
    key = cloudKey;
    url = base.endsWith("/api/v1") ? base : `${base}/api/v1`;
    // The gateway serves the vendo model family as literal ids, so EVERY slot is
    // pinned to the family name — each one the SDK leaves unset falls back to a
    // raw claude-* id, which this gateway answers `400 Unknown model id`. Env
    // only: an explicit `options.model` rides the session-open payload, which
    // beats ANTHROPIC_MODEL.
    for (const slot of SDK_MODEL_SLOT_ENV) env[slot] = "vendo";
  }
  if (key === undefined || url === undefined) return env;
  env["ANTHROPIC_API_KEY"] = key;
  // The bare origin: the SDK re-appends /v1 and wants no trailing slash.
  env["ANTHROPIC_BASE_URL"] = url.replace(/\/+$/, "").replace(/\/v1$/, "");
  return env;
}

/**
 * The reusable inference credential a boxed session holds, for a redactor to
 * strip from anything the turn streams back to the user (VEGA-INFO-00021). It is
 * exactly the value that becomes the box's `ANTHROPIC_API_KEY`, read through the
 * SAME selection law as `inferenceEnv()` so the two can never name a different
 * secret. Empty when the box gets no credential (a no-key BYO deployment) — then
 * there is nothing to redact. The 8-char floor keeps a pathological short value
 * from blanking legitimate output.
 */
export function inferenceSecrets(): readonly string[] {
  const key = inferenceEnv()["ANTHROPIC_API_KEY"];
  return key !== undefined && key.length >= 8 ? [key] : [];
}

/** The host the Agent SDK talks to when nothing overrides `ANTHROPIC_BASE_URL`. */
const DEFAULT_INFERENCE_HOST = "api.anthropic.com";

/** Domains compare case-insensitively and may carry stray spacing — the same
 *  normalization `normalizeEgressDomain` applies to a declaration. */
const normalizeDomain = (domain: string): string => domain.trim().toLowerCase();

const hostOf = (url: string | undefined): string | undefined => {
  if (url === undefined || url === "") return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * The conversational box's outbound allowlist — the ONE place its network
 * boundary is assembled.
 *
 * Same shape as the served-app machine's (`boxAllowlist` in `@vendoai/apps`
 * `egress-approval.ts`): the box's OWN skin rides unconditionally, and
 * everything else is filtered out at the provider's DOMAIN layer.
 *
 * Do not rely on that for anything: the filtering is real against ordinary
 * clients and is BYPASSABLE by
 * a client that omits SNI (`openssl s_client -noservername` reaches arbitrary
 * IPs even under an empty list — measured). It is a provider-level gap this
 * repo cannot close. So this list raises the cost of exfiltration and stops
 * every ordinary client; it does not make the box unable to reach the network.
 *
 * Two skin entries, because a session box needs exactly two things to function:
 *
 *   1. the INFERENCE host — the SDK runs the model from inside the box, so a box
 *      that cannot reach it cannot think. Read off the env the box is actually
 *      handed, never guessed, so a managed-inference gateway
 *      (`VENDO_INFERENCE_URL` → `ANTHROPIC_BASE_URL`) is allowed and
 *      `api.anthropic.com` is not.
 *   2. the DOOR origin — every host tool travels the host's MCP door now
 *      (10-mcp §3b), so this is what replaced "the box holds nothing and reaches
 *      nothing". Per DEPLOYMENT, so it arrives from composition's `toolDoor`
 *      rather than being written down here.
 *
 * Nothing else: no npm registry, no telemetry, no update endpoint. The SDK is
 * baked into the machine image, and the CLI's side traffic is switched off in
 * `inferenceEnv()`.
 */
export function boxEgress(
  inference: Record<string, string>,
  doorUrl: string | undefined,
  extra: readonly string[] = [],
): string[] {
  const domains = [
    hostOf(inference["ANTHROPIC_BASE_URL"]) ?? DEFAULT_INFERENCE_HOST,
    hostOf(doorUrl),
    ...extra.map(normalizeDomain),
  ].filter((domain): domain is string => domain !== undefined && domain !== "");
  return [...new Set(domains)];
}

/** Test + shutdown seam: drop every live box. */
export async function disposeSessionMachines(): Promise<void> {
  const entries = [...boxes.entries()];
  boxes.clear();
  for (const [, entry] of entries) {
    disarmIdle(entry);
    await entry.machine.destroy().catch(() => undefined);
  }
}
