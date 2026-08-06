/**
 * The composition seam that turns a `Harness` into a served turn.
 *
 * `@vendoai/harnesses` owns the runtime — building the `Turn`, mirroring tool
 * calls, persisting, emitting hot-path views. What it deliberately does NOT own
 * is anything that needs a `RunContext`, because a harness is permission-blind by
 * contract (§1). That leaves exactly this file's job: resolve the per-turn things
 * from the request's principal — the thread, the workspace, the `/host`
 * projection, the system prompt, the descriptor catalog — and hand the runtime a
 * `TurnRunInput`.
 *
 * It decides nothing about how to think. Every value below is a façade or a gate.
 */
import {
  VendoError,
  createTurnSkills,
  hostComponentFiles,
  hostSkillFiles,
  isUnattended,
  type FilesAdapter,
  type Harness,
  type Membership,
  type NormalizedCatalog,
  type Skill,
  type Principal,
  type ResolvedModels,
  type RunContext,
  type ThreadId,
  type ToolDescriptor,
  type ToolRegistry,
  type WorkspaceFs,
} from "@vendoai/core";
import { ThreadRepository, type Thread, type ThreadSummary } from "./threads.js";
import type { VendoGuard } from "@vendoai/guard";
import { harnessStateStore, threadMessageStore, workspaceStore, type VendoStore } from "@vendoai/store";
import {
  createDiscoveryRails,
  createHarnessRuntime,
  latestUserIntent,
  provideHarnessAdapters,
  THREAD_ID_HEADER,
  upsertMessage,
  validateMessage,
  validateUpsert,
  wireErrorMessage,
  type CapabilityMissConfig,
  type ToolDoorPort,
  type DiscoveryRails,
  type HarnessRuntimeDeps,
  type ToolBridgeOptions,
  type ToolSearchConfig,
} from "@vendoai/harnesses";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { LanguageModel, UIMessage, UIMessageStreamWriter } from "ai";

/** One scripted turn's body: everything it writes goes onto the same stream a
 *  live turn writes to, and is persisted by the same `onFinish`. Tour mode's
 *  play shape — it lives here because this door is the one that serves the
 *  turns a tour scripts. */
export type ScriptedTurn = (input: {
  writer: UIMessageStreamWriter<UIMessage>;
  signal?: AbortSignal;
}) => Promise<void>;


export interface HarnessTurnsConfig {
  /** The resolved harness. Composition (server.ts) resolves the default —
   *  `vendo()` with the hire reporter — so there is exactly ONE construction
   *  and the gate-checked value IS the served value. */
  harness: Harness<never>;
  store: VendoStore;
  /** THE deployment's files adapter (`selectStore`), so workspace blobs are
   *  written where the erase cascade will look for them. */
  files: FilesAdapter;
  guard: VendoGuard;
  /** The composed sandbox adapter (`selectSandbox`). A harness declaring
   *  `requires: { sandbox: true }` — `claudeCode()` — is constructed by the HOST
   *  at boot, where no composition exists, so composition fills its slot here
   *  instead. Unset, such a harness must be handed one directly
   *  (`claudeCode({ sandbox })`), and the boot gate refuses if neither happened. */
  sandbox?: unknown;
  /** The guard-bound registry — the one choke point, already carrying the
   *  connect gate and unique-title assertion. */
  tools: ToolRegistry;
  /** Every merged skill, projected into the read-only `/host/skills` mount. */
  skills: readonly Skill[];
  /** The resolved component catalog — the SAME normalized value the prompt
   *  summary is built from — projected into `/host/components` as one reference
   *  file per entry. Unset ⇒ no component reference on the mount. */
  catalog?: NormalizedCatalog;
  models: ResolvedModels<LanguageModel>;
  /** The venue-gated, guard-directions-carrying system prompt. Assembled per
   *  turn by composition because it needs the ctx a `Turn` does not carry.
   *
   *  `discovery` names which rail THIS turn's harness actually has, so the prompt
   *  never teaches a tool that is not on the listing: an uncurated surface
   *  (`toolSurface.curated === false`) has no `find_tools`, only the connector
   *  pair — and `false` when it has neither. */
  system: (
    ctx: RunContext,
    opts?: { discovery?: "find-tools" | "connectors" | false },
  ) => Promise<string | undefined>;
  /** The descriptor catalog the loadout and `find_tools` work over — projected for
   *  THIS ctx, so THE LAW's unattended filter decides what the model can even see,
   *  and search can never resolve its way back to a withheld tool. */
  descriptors: (ctx: RunContext) => Promise<ToolDescriptor[]>;
  /** The shipped `find_tools` rail: the search seam, the connect-required
   *  annotation, and the loadout caps. Unset → no discovery rail (`list()` offers
   *  everything projected), which is what the harness path carried before. */
  toolSearch?: ToolSearchConfig;
  /** The shipped capability-miss rail. Load-bearing for evaluation E1's fifth ask:
   *  an impossible request must produce an honest refusal, not an invention. */
  capabilityMiss?: CapabilityMissConfig;
  /** Is the `find_service_tools` / `use_service_tool` pair projected at all? Only
   *  when a configured connector can actually search and dispatch the broker's
   *  catalog (server.ts gates the registry add on that) — otherwise an uncurated
   *  surface, which has no `find_tools` either, would be taught two tools that are
   *  not on its listing. */
  connectorDiscovery?: boolean;
  /** The render seam's halves composition owns, per turn — like `bridge` below,
   *  and for the same reason: the app half (`authoredApp`) stores the app row and
   *  runs the tree's queries as the CALLER, so it needs this turn's ctx. */
  render?: (ctx: RunContext) => HarnessRuntimeDeps["render"];
  /** The shipped tool-bridge rails composition owns, per turn (`toolOutputCap`,
   *  the connect `preflight`, the capability-miss `onCall`). */
  bridge?: (ctx: RunContext, threadId: ThreadId) => HarnessRuntimeDeps["bridge"];
  /** Test seam only; production uses the frozen APPROVAL_WAIT_MS. */
  approvalWaitMs?: number;
  /** Build contract §9.1 — the host's own org query, keyed on the Principal so
   *  the workspace door can resolve it with no request in hand. It decides the
   *  turn's `/orgs` mount set (§9.7); unset ⇒ no org mounts, exactly today's
   *  single-player façade. */
  memberships?: (principal: Principal) => Promise<Membership[]>;
  /** Publish each turn in flight to the process's own doors — the MCP door's
   *  turn credential (10-mcp §3b) is the one consumer. Composition owns the
   *  registry because it is the only place that holds both ends. */
  liveTurn?: HarnessRuntimeDeps["liveTurn"];
  /** The host's own MCP door, for a harness whose thinker runs on a MACHINE and
   *  therefore reaches `turn.tools` over the wire rather than in process. */
  toolDoor?: ToolDoorPort;
  /** Tour mode's scripted-turn seam — the SAME hook `createAgent` takes, wired
   *  here too because post-flip this door serves the turns. Consulted once per
   *  turn, after the thread is resolved and this message is upserted into it,
   *  before any harness work: a play REPLACES the turn, undefined leaves it
   *  untouched. A deployment on the `agent.stream` fallback (a store with no
   *  SQL handle) is served by the agent's own copy of this seam, so tour mode
   *  behaves identically whichever door runs. */
  scripted?: (input: {
    message: UIMessage;
    messages: readonly UIMessage[];
    ctx: RunContext;
  }) => Promise<ScriptedTurn | undefined>;
}

export interface HarnessTurns {
  /** One turn. Mirrors `VendoAgent.stream`'s signature so the wire route reads
   *  the same either way — including the `x-vendo-thread-id` response header. */
  stream(input: {
    threadId?: string;
    message: UIMessage;
    ctx: RunContext;
    signal?: AbortSignal;
  }): Promise<Response>;
  /** The workspace as one principal sees it this turn. Exposed for the host and
   *  for the undo/history doors; `open` builds a fresh path index per call.
   *  The `/orgs` mounts (§9.7) come from the host's memberships seam, resolved
   *  here — a caller may override with `memberships` when it already has them. */
  workspace(
    principal: Principal,
    opts?: { host?: Record<string, string>; memberships?: Membership[] },
  ): Promise<WorkspaceFs>;
  /** D4 — the thread LIFECYCLE, on the door that serves the turns. The same
   *  `ThreadRepository` this door already resolves every turn through, so the
   *  listing, the read and the delete a client sees are the ones the turn wrote.
   *  Unlike `stream`, this needs no SQL: the repository is adapter-only, so these
   *  work on a hosted store too. */
  threads: {
    get(id: ThreadId, ctx: RunContext): Promise<Thread | null>;
    list(ctx: RunContext): Promise<ThreadSummary[]>;
    /** Also releases the thread's searched-in loadout, so a reused id can never
     *  inherit stale tools — the cleanup stays glued to the delete. */
    delete(id: ThreadId, ctx: RunContext): Promise<void>;
  };
  /** D6 — drop a subject's threads when its ephemeral session is swept, and
   *  release each evicted thread's loadout with them. */
  evictSubject(subject: string): Promise<void>;
}

export function createHarnessTurns(config: HarnessTurnsConfig): HarnessTurns {
  const threads = new ThreadRepository(config.store);
  // LAZY, and the laziness is load-bearing twice over.
  //
  // These three helpers pick their backend (`backendOf`) as their first act.
  // Building them at compose would (a) do work inside `createVendo`, which the
  // common edge wiring calls at module init where Workers forbids it, and (b)
  // throw outright for a store that offers neither a SQL handle nor a StoreOps
  // surface. Deferred, such a deployment composes exactly as before and only a
  // host that actually drives a harness turn meets the gap.
  let sql: {
    transcript: ReturnType<typeof threadMessageStore<UIMessage>>;
    workspaces: ReturnType<typeof workspaceStore>;
    harnessState: ReturnType<typeof harnessStateStore>;
  } | undefined;
  const sqlDoors = (): NonNullable<typeof sql> => {
    if (sql === undefined) {
      try {
        sql = {
          transcript: threadMessageStore<UIMessage>(config.store),
          workspaces: workspaceStore(config.store, { files: config.files }),
          // §1.3 made DURABLE. A session-owning harness reads its state on the
          // turn AFTER the one that wrote it, so the process-lifetime default
          // meant a re-seed on every restart and on every second replica.
          harnessState: harnessStateStore(config.store),
        };
      } catch (cause) {
        throw new VendoError(
          "not-implemented",
          "Serving a turn through a harness needs somewhere to keep the transcript and the workspace "
          + "(build contract §3.3 / §6): it needs a SQL-backed store (`store: postgres(url)`, or the "
          + "local default) or a StoreOps-capable store (the Cloud hosted store). The configured store "
          + "is neither.",
          { cause },
        );
      }
    }
    return sql;
  };
  /**
   * The `/host` mount for this deployment: skills as SKILL.md files (plus
   * their companion files), and the component catalog as one reference file each.
   *
   * A plain value recomputed per turn rather than stored rows — both halves are
   * code values the host's own deploy updates, so there is nothing to migrate,
   * invalidate, or erase (core `skills.ts`, `host-components.ts`).
   */
  const hostProjection = (): Record<string, string> => ({
    ...hostSkillFiles(config.skills),
    ...hostComponentFiles(config.catalog ?? []),
  });

  /**
   * Who thinks arrives RESOLVED from composition (server.ts) — the host's
   * choice or the `vendo()` default, one construction, gate-checked = served.
   *
   * The system prompt is deliberately NOT a dep here. It used to be, and that is
   * exactly what made the documented `harness: vendo()` opt-in think with an empty
   * prompt: a named harness is constructed by the HOST, at boot, so composition
   * has no seam to hand it anything. It rides `Turn.system` instead (core §1
   * amendment), which the runtime delivers to every harness — named, defaulted, or
   * a host's own — off ONE assembly.
   *
   * `vendo()` no longer takes a descriptor catalog either. It reads
   * `turn.tools.list()` like any other harness, which is what puts every harness on
   * the same discovery rail: the loadout, `find_tools` and the curated menu are the
   * RUNTIME's, so a host's own thinker gets them without asking.
   */
  // Deployment-scoped, filled once: the adapter is a deployment fact, so nothing
  // here could attribute one user's machine to another user's thread.
  if (config.sandbox !== undefined) {
    provideHarnessAdapters(config.harness, { sandbox: config.sandbox });
  }
  // The door is a DEPLOYMENT fact too — where it is, and how to mint a
  // conversation credential for it. The credential itself is per-conversation
  // and per-turn; this slot only carries the ability to ask for one.
  if (config.toolDoor !== undefined) {
    provideHarnessAdapters(config.harness, { toolDoor: config.toolDoor });
  }

  /**
   * The per-THREAD searched-in set, exactly as `createAgent` keeps one: a tool
   * discovered through `find_tools` stays callable for the rest of the
   * conversation, and the LRU cap bounds memory in a long-lived process where
   * threads are never evicted.
   */
  const loadedTools = new Map<string, Set<string>>();
  const MAX_LOADED_THREADS = 1024;
  const loadedFor = (threadId: string): Set<string> => {
    const existing = loadedTools.get(threadId);
    if (existing !== undefined) {
      loadedTools.delete(threadId);
      loadedTools.set(threadId, existing); // touch: most-recently-used
      return existing;
    }
    const fresh = new Set<string>();
    loadedTools.set(threadId, fresh);
    while (loadedTools.size > MAX_LOADED_THREADS) {
      const oldest = loadedTools.keys().next().value;
      if (oldest === undefined) break;
      loadedTools.delete(oldest);
    }
    return fresh;
  };

  /**
   * This turn's discovery rails. Every input is ctx-shaped, which is why they are
   * built here and not at compose: the projected catalog, the connection-scoped
   * seed, the host's surface menu, and the user's latest intent.
   *
   * The seed and the menu are resolved BESIDE each other and each degrades on
   * failure rather than failing the turn — the shipped path's own rule. A failed
   * menu degrades to unrestricted (the composition seam owns the warning); an
   * EMPTY menu is a real answer and must not read as unrestricted, which is why
   * `undefined` and `[]` are kept apart.
   */
  const discoveryFor = async (
    ctx: RunContext,
    threadId: ThreadId,
    messages: readonly UIMessage[],
  ): Promise<DiscoveryRails | undefined> => {
    if (config.toolSearch === undefined && config.capabilityMiss === undefined) return undefined;
    let seedNames: string[] | undefined;
    if (config.toolSearch?.seed !== undefined) {
      try {
        seedNames = await config.toolSearch.seed(ctx);
      } catch {
        seedNames = undefined;
      }
    }
    let menuNames: readonly string[] | undefined;
    if (config.toolSearch?.menu !== undefined) {
      try {
        menuNames = await config.toolSearch.menu(ctx);
      } catch {
        menuNames = undefined;
      }
    }
    return createDiscoveryRails({
      descriptors: await config.descriptors(ctx),
      ctx,
      loaded: loadedFor(threadId),
      ...(config.toolSearch === undefined ? {} : { toolSearch: config.toolSearch }),
      ...(seedNames === undefined ? {} : { seedNames }),
      ...(menuNames === undefined ? {} : { menuNames }),
      // A search hit outside the built catalog was lazily expanded during the
      // search itself; re-reading the PROJECTED catalog resolves it, so the same
      // LAW filter applies to what search can reach.
      resolve: async (names) => (await config.descriptors(ctx)).filter((d) => names.includes(d.name)),
      ...(config.capabilityMiss === undefined
        ? {}
        : {
            capabilityMiss: {
              config: config.capabilityMiss,
              intent: latestUserIntent([...messages]),
              threadId,
            },
          }),
    });
  };

  return {
    threads: {
      get: (id, ctx) => threads.get(id, ctx),
      list: (ctx) => threads.list(ctx),
      delete: async (id, ctx) => {
        loadedTools.delete(id);
        await threads.delete(id, ctx);
      },
    },

    async evictSubject(subject) {
      // Release each evicted thread's searched-in loadout so a reused id can't
      // inherit stale tools, and so memory is reclaimed on session sweep. Awaited
      // rather than fire-and-forget (`createAgent`'s signature was synchronous):
      // the caller is the sweep, which has somewhere to put a failure.
      for (const id of await threads.evictSubject(subject)) {
        loadedTools.delete(id);
      }
    },

    async workspace(principal, opts) {
      // §9.7 — the mount set is the host's ASSERTIONS for this principal. The
      // seam is keyed on the principal precisely so this door (which has no
      // request) can ask the same question the wire asks per request.
      const asserted = opts?.memberships ?? await config.memberships?.(principal);
      return await sqlDoors().workspaces.open(principal, {
        host: opts?.host ?? hostProjection(),
        ...(asserted === undefined ? {} : { memberships: asserted }),
      });
    },

    async stream(input) {
      validateMessage(input?.message);
      // The thread is resolved through the SHIPPED repository: same id pattern,
      // same "already in use" refusal for a foreign thread, same title
      // derivation — and `thread.messages` is the canonical transcript read back
      // from `vendo_thread_messages`.
      const thread = await threads.resolve(input.threadId as ThreadId | undefined, input.ctx);

      // THE CONSTRAINT (lane A's verifier): `TurnRunInput.messages` is
      // STORE-SOURCED. The client contributes at most this one message, and
      // `validateUpsert` is the shipped rule for whether it may — a fresh user
      // message, or an answer to a pending approval, and nothing else.
      //
      // Wiring the client's posted transcript instead is the bug that hides
      // here: the runtime flips a superseded `approval-requested` part to
      // abandoned and persists the flip, so a client holding the PRE-flip copy
      // re-posts an assistant message that no longer matches the store. That is
      // a history-forging attempt by the validator's rules, so it throws — and it
      // throws on every subsequent turn too, for as long as that client keeps
      // sending its stale copy. The thread becomes permanently unusable for them.
      validateUpsert(thread.messages, input.message);
      upsertMessage(thread.messages, input.message);

      // Before the FIRST write, not after it. `threads.persist` goes through the
      // adapter seam and so succeeds even on a store that can keep neither the
      // transcript nor the workspace — so resolving the doors any later makes the
      // refusal a half-write, leaving a `vendo_threads` row carrying the user's
      // message on a deployment that can never answer it.
      const { transcript, workspaces, harnessState } = sqlDoors();

      // The thread ROW has to exist before the runtime writes message rows:
      // `threadMessageStore.upsert` sources its INSERT from `vendo_threads`
      // joined on the subject, so a missing row is refused rather than created.
      // This one write also lands the user's message and refreshes the listing
      // title, exactly as a `createAgent` turn's persist does.
      await threads.persist(thread, [input.message]);

      // Tour mode. Ahead of every other decision because a scripted turn makes
      // none of them: no workspace is mounted, no toolset is built, no system
      // prompt is assembled, no harness runs. Same position, same contract, and
      // the same persistence as `createAgent`'s copy — a turn nobody scripted
      // falls through with nothing written and no trace it was offered here.
      const play = await config.scripted?.({
        message: input.message,
        messages: thread.messages,
        ctx: input.ctx,
      });
      if (play !== undefined) {
        const scripted = createUIMessageStream<UIMessage>({
          originalMessages: thread.messages,
          execute: async ({ writer }) => {
            if (input.signal?.aborted) return;
            await play({ writer, ...(input.signal === undefined ? {} : { signal: input.signal }) });
          },
          onFinish: async ({ messages }) => {
            await threads.persist(thread, messages);
          },
          onError: (error) => wireErrorMessage(error),
        });
        const played = createUIMessageStreamResponse({ stream: scripted });
        played.headers.set(THREAD_ID_HEADER, thread.id);
        return played;
      }

      // §9.7 — the turn's façade mounts every org the wire asserted for this
      // request, so an agent turn can read and write the team's files at all.
      const workspace = await workspaces.open(input.ctx.principal, {
        host: hostProjection(),
        ...(input.ctx.memberships === undefined ? {} : { memberships: input.ctx.memberships }),
      });
      const runtime = createHarnessRuntime({
        tools: config.tools,
        guard: config.guard,
        // Read off THIS turn's mount, so a skill the host stopped shipping is
        // gone the moment they deploy — no stale copy to invalidate.
        skills: createTurnSkills(workspace),
        transcript,
        harnessState,
        ...(config.render === undefined ? {} : { render: config.render(input.ctx) }),
        ...(config.bridge === undefined
          ? {}
          : { bridge: config.bridge(input.ctx, thread.id) as ToolBridgeOptions | undefined }),
        ...(config.approvalWaitMs === undefined ? {} : { approvalWaitMs: config.approvalWaitMs }),
        ...(config.liveTurn === undefined ? {} : { liveTurn: config.liveTurn }),
      });

      const discovery = await discoveryFor(input.ctx, thread.id, thread.messages);
      // Assembled once, per turn, for WHOEVER thinks. The venue gate and the guard's
      // directions live in here, which is why it is composition's job and not the
      // harness's. Which discovery section it may promise is decided by what is
      // actually on the listing: a curated surface has `find_tools`, an uncurated one
      // has the connector pair (and only with connectors configured), or neither.
      const rail = config.harness.toolSurface?.curated !== false
        ? "find-tools" as const
        : config.connectorDiscovery === true ? "connectors" as const : false;
      const system = await config.system(input.ctx, { discovery: rail });
      const response = await runtime.run<never>({
        harness: config.harness,
        threadId: thread.id,
        messages: thread.messages,
        ctx: input.ctx,
        workspace,
        models: config.models,
        ...(system === undefined ? {} : { system }),
        ...(discovery === undefined ? {} : { discovery }),
        // §1.4 — presence is proof, and `isUnattended` is the one predicate that
        // decides it. Interactive turns await the tap inside `call()`; the rest
        // fail loudly with a standing card.
        interactive: !isUnattended(input.ctx),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      // A caller may begin without an id; hand the effective one back on every
      // turn, like `createAgent` does, so the wire can register turn liveness.
      response.headers.set(THREAD_ID_HEADER, thread.id);
      return response;
    },
  };
}
