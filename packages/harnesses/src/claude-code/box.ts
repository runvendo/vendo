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
import { log, VENDO_DEV_PORT, VENDO_DEV_PORT_ENV, VendoError } from "@vendoai/core";
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
/** How long a box may sit between messages before it is destroyed. */
export const BOX_IDLE_TTL_MS = 5 * 60_000;
/** The box holds each poll open this long before answering empty. */
const POLL_WAIT_MS = 10_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface BoxEntry {
  machine: SandboxMachineLike;
  /** Minted once, at create. There is no rotation: a box is never restored from
   *  a snapshot, so no supervisor ever comes back holding a stale token. */
  token: string;
  /** Has this box been materialized and had its session opened? */
  warm: boolean;
  /** What this box's disk holds — the sync-back baseline, per conversation. */
  tree: TreeState;
  idle?: ReturnType<typeof setTimeout>;
}

/** One box per THREAD, for as long as the conversation stays warm. Module-scoped
 *  because that is what "the box outlives the turn" means. */
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

  /**
   * The credential handoff, and the only one. The box trusts the first hello
   * while it is unclaimed and refuses every other caller after.
   *
   * CLAUDE_CONFIG_DIR is deliberately unset: the SDK's default lives under $HOME,
   * and `/workspace` is the materialized copy — parking the native session there
   * would put machine state inside the user's files.
   */
  const hello = async (machine: SandboxMachineLike, token: string): Promise<boolean> => {
    const { status } = await control(machine, token, "/session/hello", {
      token,
      env: options.env,
    }).catch(() => ({ status: 0, json: undefined }));
    return status === 200;
  };

  const bootBox = async (): Promise<BoxEntry> => {
    const token = mintToken();
    const machine = await options.sandbox.create({
      ...(template === undefined ? {} : { template }),
      env: {
        ...options.env,
        VENDO_BOX_TOKEN: token,
        VENDO_WORKSPACE_ROOT: "/workspace",
        // The dev port is DECLARED here, at create, from the same core constant
        // the template's vite config resolves. A preview URL is minted from it
        // before the dev server has necessarily booted, so it can never be
        // discovered post-boot — and a second literal is how the two drift.
        [VENDO_DEV_PORT_ENV]: String(VENDO_DEV_PORT),
      },
      allowedDomains: [...options.allowedDomains],
    });
    if (!await hello(machine, token)) {
      await machine.destroy().catch(() => undefined);
      throw new VendoError(
        "sandbox-unavailable",
        "the workspace machine refused the session handshake",
      );
    }
    const fresh: BoxEntry = { machine, token, warm: false, tree: emptyTree() };
    boxes.set(options.threadId, fresh);
    return fresh;
  };

  const existing = boxes.get(options.threadId);
  let entry: BoxEntry | undefined;
  if (existing !== undefined) {
    disarmIdle(existing);
    // PROBE, never assume. A box can be gone without us having asked — a
    // provider reap, an idle policy on their side, a host that slept. Handing
    // that corpse out made the thread fail in a third of a second for the whole
    // process lifetime; only a restart recovered it. `hello` re-presenting the
    // SAME token is the cheapest round trip the box answers.
    if (await hello(existing.machine, existing.token)) {
      entry = existing;
    } else {
      log({
        code: "harnesses.claude-code-box-stale",
        level: "error",
        message: "[vendo] claude-code: the box stopped answering; starting fresh",
      });
      boxes.delete(options.threadId);
      await existing.machine.destroy().catch(() => undefined);
    }
  }
  entry ??= await bootBox();
  const box = entry;

  const request = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const { status, json } = await control(box.machine, box.token, path, body);
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
    pluginPath: "/workspace/host",

    tree: box.tree,

    async url(port: number) {
      return await box.machine.url(port);
    },

    async materialize(files: readonly CheckoutFile[]) {
      // Chunked by COUNT, which bounds the typical upload body — not a hard
      // byte bound: one large file still travels alone in its chunk, and a
      // BYO files adapter can hold files the proxy may refuse.
      const CHUNK = 24;
      for (let at = 0; at < files.length; at += CHUNK) {
        await request("/session/workspace", {
          reset: at === 0,
          files: files.slice(at, at + CHUNK).map((file) => ({
            path: file.path,
            readOnly: file.readOnly,
            base64: Buffer.from(file.bytes).toString("base64"),
          })),
        });
      }
      if (files.length === 0) await request("/session/workspace", { reset: true, files: [] });
    },

    async collect(paths) {
      const answer = await request("/session/collect", paths === undefined ? {} : { paths });
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
        reopen: message.reopen,
        pluginPath: message.pluginPath,
        skillNames: message.skillNames,
        toolDoor: message.toolDoor,
      });
      // From here on the box holds a session, so a next message on this thread
      // neither re-materializes nor re-seeds.
      box.warm = true;
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
      armIdle(options.threadId, box, idleTtlMs);
    },
  };
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
