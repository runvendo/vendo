/**
 * The composition seam that turns a `Harness` into a served turn.
 *
 * `@vendoai/harnesses` owns the runtime — building the `Turn`, mirroring tool
 * calls, persisting, running the injected workspace wrap that emits hot-path
 * views. What it deliberately does NOT own
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
  type ToolRegistry,
  type WorkspaceFs,
} from "@vendoai/core";
import { ThreadRepository, type Thread, type ThreadSummary } from "./threads.js";
import { wrapWorkspaceForRender, type RenderSeamOptions } from "@vendoai/apps";
import type { VendoGuard } from "@vendoai/guard";
import { harnessStateStore, threadMessageStore, workspaceStore, type VendoStore } from "@vendoai/store";
import {
  createHarnessRuntime,
  latestUserIntent,
  provideHarnessAdapters,
  THREAD_ID_HEADER,
  upsertMessage,
  validateMessage,
  validateUpsert,
  type CapabilityMissConfig,
  type ToolDoorPort,
  type HarnessRuntimeDeps,
  type ToolBridgeOptions,
} from "@vendoai/harnesses";
import type { VendoToolSearchConfig } from "@vendoai/harnesses/vendo";
import type { LanguageModel, UIMessage } from "ai";

export interface HarnessTurnsConfig {
  /** The resolved harness. Composition (server.ts) resolves the default —
   *  `vendo()` with its tool-search strategy — so there is exactly ONE
   *  construction and the gate-checked value IS the served value. */
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
  /** vendo()'s tool-search strategy — the loadout cap and the `find_tools` hand.
   *  Composition passes it to the DEFAULT harness at construction
   *  (compose-harness.ts); this copy fills the composed adapter slot so a
   *  HOST-constructed `vendo()` gets the same strategy, like `claudeCode()`'s
   *  sandbox. Unset → no search and every projected tool offered. */
  toolSearch?: VendoToolSearchConfig;
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
   *  runs the tree's queries as the CALLER, so it needs this turn's ctx. Wired
   *  into the runtime's generic `wrapWorkspace` slot below — the runtime itself
   *  no longer knows the seam. */
  render?: (ctx: RunContext) => Omit<RenderSeamOptions, "emit">;
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
   *  for the history door; `open` builds a fresh path index per call.
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
    delete(id: ThreadId, ctx: RunContext): Promise<void>;
  };
  /** D6 — drop every thread a subject owns. */
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
   * `vendo()` reads `turn.tools.list()` like any other harness — the projected,
   * menu-bound surface. How it COPES with a large one (the loadout cap,
   * `find_tools`) is its own strategy, carried in its construction and in the
   * composed adapter slot below, never a runtime rail.
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
  // vendo()'s tool-search strategy, for a HOST-constructed `vendo()` (the
  // default harness got it at construction). Same drawer as the sandbox: an
  // adapter is a deployment fact.
  if (config.toolSearch !== undefined) {
    provideHarnessAdapters(config.harness, { toolSearch: config.toolSearch });
  }

  /** The thread's harness-state slot, when this store can hold one. The slot
   *  carries a native session ref and vendo()'s searched-in loadout, so it has
   *  to die with the thread — a reused id must never inherit either (the
   *  store's own SQL `threadStore.delete` cascades the same way). A store with
   *  no SQL/ops backend never served a harness turn, so there is nothing to
   *  clear and the lifecycle stays adapter-only. */
  const stateDoor = (): ReturnType<typeof harnessStateStore> | undefined => {
    try {
      return sqlDoors().harnessState;
    } catch {
      return undefined;
    }
  };

  return {
    threads: {
      get: (id, ctx) => threads.get(id, ctx),
      list: (ctx) => threads.list(ctx),
      delete: async (id, ctx) => {
        await threads.delete(id, ctx);
        await stateDoor()?.clear(id);
      },
    },

    async evictSubject(subject) {
      // D6 — drop every thread a subject owns, its state slot with it. Awaited
      // rather than fire-and-forget: the caller is the sweep, which has
      // somewhere to put a failure.
      for (const id of await threads.evictSubject(subject)) {
        await stateDoor()?.clear(id);
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

      // §9.7 — the turn's façade mounts every org the wire asserted for this
      // request, so an agent turn can read and write the team's files at all.
      const workspace = await workspaces.open(input.ctx.principal, {
        host: hostProjection(),
        ...(input.ctx.memberships === undefined ? {} : { memberships: input.ctx.memberships }),
      });
      // §1.6 — the render seam, built for THIS turn's ctx and handed to the
      // runtime's generic `wrapWorkspace` slot: the runtime owns WHERE the wrap
      // happens and what `emit` writes to; composition owns WHAT wraps.
      const render = config.render === undefined ? undefined : config.render(input.ctx);
      const runtime = createHarnessRuntime({
        tools: config.tools,
        guard: config.guard,
        // Read off THIS turn's mount, so a skill the host stopped shipping is
        // gone the moment they deploy — no stale copy to invalidate.
        skills: createTurnSkills(workspace),
        transcript,
        harnessState,
        ...(render === undefined ? {} : {
          wrapWorkspace: (turnWorkspace, opts) => wrapWorkspaceForRender(turnWorkspace, {
            ...render,
            turnId: opts.turnId,
            emit: opts.emit,
          }),
        }),
        ...(config.bridge === undefined
          ? {}
          : { bridge: config.bridge(input.ctx, thread.id) as ToolBridgeOptions | undefined }),
        ...(config.approvalWaitMs === undefined ? {} : { approvalWaitMs: config.approvalWaitMs }),
        ...(config.liveTurn === undefined ? {} : { liveTurn: config.liveTurn }),
      });

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
        // The honest-refusal rail, per turn: the intent is the user's latest ask.
        ...(config.capabilityMiss === undefined
          ? {}
          : {
              capabilityMiss: {
                config: config.capabilityMiss,
                intent: latestUserIntent([...thread.messages]),
                threadId: thread.id,
              },
            }),
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
