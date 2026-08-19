/**
 * ONE user, bound once — and everything this agent does for them.
 *
 * A host serving a person re-stated the same three things on every call: whose
 * turn it is, what the model may say about them, and what the tools need to act
 * on their behalf. `forUser` names them once and hands back the four faces that
 * follow from it — this user's turns, their conversations, and what the agent
 * remembers about them.
 *
 * WHAT IS BOUND AND WHAT IS NOT is the whole design. `profile` and `context`
 * are FACTS about a person: true between requests, so they are bound here and
 * ride every call. `headers` are the authority of ONE request — they expire
 * with it — so they ride PER CALL and are never kept. A facade that remembered
 * the first request's cookie would spend one caller's authority on the next
 * caller's turn, and nothing downstream could tell the difference.
 *
 * IT IMPLEMENTS NOTHING. `chat` is `startChat` with the subject filled in,
 * `turns` is `createTurns`, `threads` is the store's own thread helpers and
 * `memories` is the composition's memory adapter — each scoped to this subject,
 * which is the one thing this file adds.
 */
import { VendoError, type Json, type Principal, type ThreadId } from "@vendoai/core";
import { threadMessageStore, threadStore } from "@vendoai/store";
import type { UIMessage } from "ai";
import { createTurns, type Turns } from "./interruptions.js";
import type { Memory, MemoryAdapter } from "./memory.js";
import { startChat, type AgentDeps, type ChatOptions, type Turn } from "./turn.js";

/** Who this user is, for as long as the facade lives. */
export interface UserOptions {
  /** Server-trust identity facts, model-visible (the `[User]` block) — the same
   *  channel `chat({ user })` fills, under the name a host thinks of it by.
   *  Nothing the user typed belongs here: the model reads it as established. */
  profile?: Record<string, Json>;
  /** What the guard and the host's own tools need to act for this person —
   *  a tenant, a locale, an account id. JSON-only because it is BOUND: it
   *  outlives the request that named it, and a closure bound into a long-lived
   *  facade would run in turns its author never saw. */
  context?: Record<string, unknown>;
}

/** What one call brings that a facade cannot hold: the request's own authority,
 *  the conversation to continue, and the way to stop it. `as`, `user` and
 *  `context` are gone by construction — they were bound at {@link createUser}
 *  and passing them per call is what this face exists to end. */
export type UserChatOptions = Omit<ChatOptions, "as" | "user" | "context">;

/** One conversation of this user's. */
export interface UserThread {
  readonly id: ThreadId;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The transcript, oldest first — read when it is asked for, never with the
   *  listing: a settings screen shows twenty conversations and opens one. */
  messages(): Promise<UIMessage[]>;
}

/** This user's conversations. There is no `create` and no `chat` here: a thread
 *  is what a turn leaves behind, so one begins at `user.chat(message)` and is
 *  continued with `user.chat(message, { threadId })`. */
export interface Threads {
  /** Most recently touched first. */
  list(): Promise<UserThread[]>;
  /** A thread this user does not own is `not-found` — never an empty transcript
   *  that reads like a conversation nobody said anything in. */
  get(id: string): Promise<UserThread>;
  delete(id: string): Promise<void>;
}

/** What the agent remembers about this user — the person's own view of it, so
 *  there is no `add`: a memory is made by the model calling `remember` in front
 *  of them, and forgetting is theirs alone. */
export interface Memories {
  /** Everything, newest first. */
  list(): Promise<readonly Memory[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface AgentUser {
  /** ONE turn of this user's conversation. The bound profile and context ride
   *  along; `headers` are this request's and are not kept. */
  chat(message: string, options?: UserChatOptions): Turn;
  /** The turns of theirs that are waiting on them. */
  readonly turns: Turns;
  readonly threads: Threads;
  readonly memories: Memories;
}

/** Everything one agent does for one person. `agent.forUser` is the door;
 *  this takes the composition, so a host that assembled its own can hang the
 *  same face off it. */
export function createUser(deps: AgentDeps, subject: string, options: UserOptions = {}): AgentUser {
  const principal: Principal = { kind: "user", subject };
  /** Bound ONCE and spread into every turn. Spread LAST, so no cast can talk a
   *  call into acting as somebody else. */
  const durable: Pick<ChatOptions, "as" | "user" | "context"> = {
    as: subject,
    ...(options.profile === undefined ? {} : { user: options.profile }),
    ...(options.context === undefined ? {} : { context: options.context }),
  };

  /** Every read below can be the FIRST thing a host calls — a memories screen
   *  or an approvals inbox renders before this deployment's first turn — so the
   *  schema is ensured exactly as `createSession`, the away runner and the
   *  permissions mount do, or a virgin store answers with `relation
   *  "vendo_threads" does not exist`. Latched: a polled surface must not run a
   *  migration check per call. A turn ensures it itself (turn.ts). */
  let ready: Promise<void> | undefined;
  const migrated = async (): Promise<void> => {
    ready ??= deps.store.ensureSchema();
    await ready;
  };

  const threads = threadStore(deps.store);
  const transcript = threadMessageStore<UIMessage>(deps.store);
  const asThread = (row: { id: string; createdAt: string; updatedAt: string }): UserThread => ({
    id: row.id as ThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messages: () => transcript.list(principal, row.id as ThreadId),
  });

  /**
   * The adapter, or the sentence saying it was never turned on.
   *
   * An empty list is the wrong answer for a feature nobody configured: a
   * settings screen would show "nothing remembered" where the truth is "nothing
   * is ever remembered", and `delete` would report success having removed
   * nothing. So all three verbs refuse, naming the one line that turns it on.
   */
  const memory = async (): Promise<MemoryAdapter> => {
    if (deps.memory === undefined) {
      throw new VendoError(
        "validation",
        "This agent has no memory, so there is nothing to list or forget. Pass `memory: true` to agent() "
        + "for the store-backed default, or your own MemoryAdapter.",
      );
    }
    await migrated();
    return deps.memory;
  };

  const turns = createTurns(deps, subject);

  return {
    chat: (message, callOptions) => startChat(deps, message, { ...callOptions, ...durable }),

    // `createTurns` verbatim — ONE implementation of list and resume, with this
    // subject bound.
    turns: {
      list: async (listOptions) => {
        await migrated();
        return turns.list(listOptions);
      },
      // The bound context rides a resume too. A resume's authority is the
      // RESUMING call's alone (interruptions.ts), and this IS the resuming
      // call's: the facade's standing context is alive right now, where the
      // parked request's — which that rule is about, and which is still never
      // replayed — is over. Without it a guard rule keyed on `tenantId` would
      // decide the resumed turn differently from the chat turn that parked it,
      // with nothing in the API to hint why. A per-call context wins over the
      // bound one; HEADERS are absent here and always will be, because the
      // facade holds none to carry.
      resume: async (turnId, decisions, resumeOptions) => {
        await migrated();
        const context = { ...durable.context, ...resumeOptions?.context };
        return turns.resume(turnId, decisions, {
          ...resumeOptions,
          ...(Object.keys(context).length === 0 ? {} : { context }),
        });
      },
    },

    // Every verb is scoped by the store's own ownership join, so another user's
    // thread reads back as absent here exactly as it does everywhere else.
    threads: {
      list: async () => {
        await migrated();
        return (await threads.list(principal)).map(asThread);
      },
      get: async (id) => {
        await migrated();
        const row = await threads.get(principal, id as ThreadId);
        if (row === null) {
          throw new VendoError(
            "not-found",
            `No conversation ${id} for this user. A thread belongs to whoever started it — `
            + "threads.list() has the ones this user owns.",
          );
        }
        return asThread(row);
      },
      // Idempotent by the same law: a foreign or already-deleted id sweeps
      // nothing and says nothing about what exists.
      delete: async (id) => {
        await migrated();
        await threads.delete(principal, id as ThreadId);
      },
    },

    memories: {
      list: async () => (await memory()).list(principal),
      delete: async (id) => (await memory()).delete(principal, id),
      clear: async () => (await memory()).clear(principal),
    },
  };
}
