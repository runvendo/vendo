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
  emitUsage,
  hostSkillFiles,
  isUnattended,
  situationPromptBlock,
  type FilesAdapter,
  type Harness,
  type Membership,
  type Skill,
  type Principal,
  type ResolvedModels,
  type RunContext,
  type ThreadId,
  type ToolRegistry,
  type WorkspaceFs,
} from "@vendoai/core";
import {
  hostComponentFiles,
  type NormalizedCatalog,
} from "@vendoai/apps/contract";
import { deriveTitle, ThreadRepository, type Thread, type ThreadSummary } from "./threads.js";
import {
  HOT_PATH_WATCH,
  hotPathAppId,
  repairInstruction,
  validateWrittenApps,
  wrapWorkspaceForRender,
  type RenderSeamOptions,
} from "@vendoai/apps";
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
  /** The deployment-wide approval wait. Unset uses the frozen
   *  APPROVAL_WAIT_MS; a single turn may override it (`stream`). */
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
    /** How long an interactive approval may block THIS turn. Unset keeps the
     *  frozen APPROVAL_WAIT_MS (a web tab's bound); a turn served over a
     *  channel where the person answers on a human clock passes its own. */
    approvalWaitMs?: number;
  }): Promise<Response>;
  /** Prompt-cache warming (sub-1s shipment): ONE degenerate turn through the
   *  normal assembly — same registry projection, same system prompt, same
   *  initial loadout — so the provider writes its prefix cache before the
   *  user's first real message would otherwise write it cold. Byte-identical
   *  by construction: the code that builds the warm call IS the code that
   *  builds a real turn. Nothing persists — the runtime is handed throwaway
   *  in-memory doors — and the turn is capped at one step and one output
   *  token, which can never complete a tool call, so nothing executes and
   *  the guard never fires. */
  warm(input: { ctx: RunContext; signal?: AbortSignal }): Promise<void>;
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

/** `agent_run`'s `modelFamily`: the id the THINKING seat resolved to — the
 *  finest family the ai-SDK exposes, and a name rather than a key or a URL. A
 *  harness that brings its own brain (`claudeCode()`) has no seat to read, so
 *  `null` is the whole truth. */
function modelFamilyOf(models: ResolvedModels<LanguageModel>): string | null {
  const model = models.default as LanguageModel | undefined;
  if (typeof model === "string") return model;
  const id = (model as { modelId?: unknown } | undefined)?.modelId;
  return typeof id === "string" ? id : null;
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
  // The app-document vocabulary a machine-backed driver needs: the hot-path
  // watch set, and the finish-line validate gate. `@vendoai/harnesses` no
  // longer imports `@vendoai/apps`, so composition hands the driver the REAL
  // implementations here — which is what keeps the composed path byte-identical
  // to when the driver imported them itself. Filled unconditionally: the slots
  // are inert on a harness that never reads them.
  provideHarnessAdapters(config.harness, {
    hotPaths: { watch: HOT_PATH_WATCH, appId: hotPathAppId },
    validateApps: validateWrittenApps,
    repairInstruction,
  });

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
      // Read BEFORE the upsert lands the new message: no messages = resolve
      // found no row, and persist's first attempt can skip re-reading that
      // absence (its insert is guarded either way).
      const fresh = thread.messages.length === 0;
      validateUpsert(thread.messages, input.message);
      upsertMessage(thread.messages, input.message);

      // Before the FIRST write, not after it. `threads.persist` goes through the
      // adapter seam and so succeeds even on a store that can keep neither the
      // transcript nor the workspace — so resolving the doors any later makes the
      // refusal a half-write, leaving a `vendo_threads` row carrying the user's
      // message on a deployment that can never answer it.
      const { transcript, workspaces, harnessState } = sqlDoors();

      // The turn's store reads, IN FLIGHT TOGETHER (sub-1s shipment): the state
      // read needs nothing below, and `resolve()` already read the thread row —
      // subject included — so it skips its own owner lookup. Read-only, so a
      // turn the runtime later refuses has spent a read and changed nothing.
      const stateRead = harnessState.get(thread.id, config.harness.name, thread.subject);
      // The runtime may never await it (an arbitrary history edit clears the
      // slot instead); a rejection still reaches whoever does await.
      void stateRead.catch(() => {});
      const [, workspace] = await Promise.all([
        // The thread ROW has to exist before the runtime writes message rows:
        // `threadMessageStore.upsert` sources its INSERT from `vendo_threads`
        // joined on the subject, so a missing row is refused rather than created.
        // This one write also lands the user's message and refreshes the listing
        // title, exactly as a `createAgent` turn's persist does. The workspace
        // open beside it reads file rows only — nothing it serves depends on the
        // thread row landing, and the runtime that writes messages runs after both.
        //
        // ONE persistence path per turn: `persist` writes the whole transcript
        // under a compare-and-swap, which is what CREATING the row needs and
        // what every later turn was paying for nothing. Once the row exists the
        // same three effects — the user's message, a touched `updated_at` and a
        // refreshed title — are one append, and two overlapping turns writing
        // disjoint message ids can no longer collide at all.
        fresh
          ? threads.persist(thread, [input.message], { fresh })
          // No position is passed: the store assigns one while it holds the
          // thread row, so two turns racing on this conversation cannot claim
          // the same slot. An answer to a pending approval matches an existing
          // id and keeps the position it already has.
          : transcript.upsertMany(
            input.ctx.principal,
            thread.id,
            [input.message],
            { title: deriveTitle(thread.messages) },
          ),
        // §9.7 — the turn's façade mounts every org the wire asserted for this
        // request, so an agent turn can read and write the team's files at all.
        workspaces.open(input.ctx.principal, {
          host: hostProjection(),
          ...(input.ctx.memberships === undefined ? {} : { memberships: input.ctx.memberships }),
        }),
      ]);
      // §1.6 — the render seam, built for THIS turn's ctx and handed to the
      // runtime's generic `wrapWorkspace` slot: the runtime owns WHERE the wrap
      // happens and what `emit` writes to; composition owns WHAT wraps.
      const render = config.render === undefined ? undefined : config.render(input.ctx);
      // The turn's own SHAPE, counted on the two rails this file already owns:
      // every tool call passes the bridge's `onCall`, and `liveTurn`'s disposer
      // is the runtime's turn end (it retracts the publication in the run's
      // `finally`). Names and counts only — no argument and no result.
      const startedAt = Date.now();
      const toolNames = new Set<string>();
      let toolCalls = 0;
      const emitRun = (outcome: "ok" | "error", errorCode: string | null): void => emitUsage({
        name: "agent_run",
        durationMs: Date.now() - startedAt,
        // No rail carries the thinker's step count out of the harness runtime
        // (the workbench's `step-start` is dev-only, gated on VENDO_WORKBENCH),
        // so this stays 0 until the runtime publishes one.
        steps: 0,
        toolCalls,
        tools: [...toolNames].sort(),
        modelFamily: modelFamilyOf(config.models),
        outcome,
        errorCode,
      });
      const bridge = config.bridge?.(input.ctx, thread.id) as ToolBridgeOptions | undefined;
      const runtime = createHarnessRuntime({
        tools: config.tools,
        guard: config.guard,
        // Read off THIS turn's mount, so a skill the host stopped shipping is
        // gone the moment they deploy — no stale copy to invalidate.
        skills: createTurnSkills(workspace),
        // THIS turn's doors answer from what stream() already read, instead of
        // re-fetching the same thread row (it used to be read four times before
        // the model saw a token): the transcript IS `thread.messages` — resolve
        // read the row and persist just wrote this copy — and the state read has
        // been in flight since before the workspace opened. Any other thread,
        // and every other verb, falls through to the live doors unchanged.
        transcript: {
          ...transcript,
          list: async (principal, threadId) =>
            threadId === thread.id && principal.subject === thread.subject
              ? structuredClone(thread.messages)
              : transcript.list(principal, threadId),
        },
        harnessState: {
          get: (threadId, harnessName) =>
            threadId === thread.id && harnessName === config.harness.name
              ? stateRead
              : harnessState.get(threadId, harnessName),
          set: (threadId, harnessName, value) =>
            harnessState.set(threadId, harnessName, value, threadId === thread.id ? thread.subject : undefined),
          clear: (threadId) =>
            harnessState.clear(threadId, threadId === thread.id ? thread.subject : undefined),
        },
        ...(render === undefined ? {} : {
          wrapWorkspace: (turnWorkspace, opts) => wrapWorkspaceForRender(turnWorkspace, {
            ...render,
            turnId: opts.turnId,
            emit: opts.emit,
          }),
        }),
        bridge: {
          ...bridge,
          onCall: (call) => {
            toolCalls += 1;
            toolNames.add(call.tool);
            return bridge?.onCall?.(call) ?? (() => {});
          },
        },
        // The turn's own wait wins over the deployment's, and both fall back to
        // the frozen default inside the runtime.
        ...((input.approvalWaitMs ?? config.approvalWaitMs) === undefined
          ? {}
          : { approvalWaitMs: input.approvalWaitMs ?? config.approvalWaitMs }),
        liveTurn: (published) => {
          const unpublish = config.liveTurn?.(published);
          return () => {
            unpublish?.();
            emitRun("ok", null);
          };
        },
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
      // Spec 2026-08-05 §2, relocated (sub-1s shipment): the screen snapshot is
      // delivered BESIDE the stable prompt, not inside it — it changes every
      // message, and volatile bytes ahead of stable ones are what kept the
      // provider's prompt cache cold. Same block builder, same this-turn-only
      // life: the ctx and `Turn.situation`, never the store.
      const situation = situationPromptBlock(input.ctx.context);
      const response = await runtime.run<never>({
        harness: config.harness,
        threadId: thread.id,
        messages: thread.messages,
        ctx: input.ctx,
        workspace,
        models: config.models,
        ...(system === undefined ? {} : { system }),
        ...(situation === undefined ? {} : { situation }),
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
      }).catch((error: unknown) => {
        // The turn ended before it ran: mounting the toolset, minting a turn
        // credential or building the stream threw, so nothing was published and
        // the disposer above will never fire.
        emitRun("error", error instanceof VendoError ? error.code : "unknown");
        throw error;
      });
      // A caller may begin without an id; hand the effective one back on every
      // turn, like `createAgent` does, so the wire can register turn liveness.
      response.headers.set(THREAD_ID_HEADER, thread.id);
      return response;
    },

    async warm(input) {
      const { workspaces } = sqlDoors();
      const workspace = await workspaces.open(input.ctx.principal, {
        host: hostProjection(),
        ...(input.ctx.memberships === undefined ? {} : { memberships: input.ctx.memberships }),
      });
      const runtime = createHarnessRuntime({
        tools: config.tools,
        guard: config.guard,
        skills: createTurnSkills(workspace),
        // Throwaway doors: a warm turn leaves no transcript, no state, no rows.
        transcript: { upsert: async () => {}, list: async () => [] },
        harnessState: { get: async () => undefined, set: async () => {}, clear: async () => {} },
      });
      const rail = config.harness.toolSurface?.curated !== false
        ? "find-tools" as const
        : config.connectorDiscovery === true ? "connectors" as const : false;
      const system = await config.system(input.ctx, { discovery: rail });
      const response = await runtime.run<{ maxSteps: number; maxOutputTokens: number }>({
        harness: config.harness,
        threadId: `thr_warm${globalThis.crypto.randomUUID().replaceAll("-", "")}` as ThreadId,
        messages: [{
          id: "warm",
          role: "user",
          parts: [{ type: "text", text: "Reply with one word." }],
        } as UIMessage],
        ctx: input.ctx,
        workspace,
        models: config.models,
        ...(system === undefined ? {} : { system }),
        // The capability-miss hand is part of the projected tools block, so the
        // warm prefix must mount it exactly as a real turn does; its intent
        // never reaches the descriptor (capability-miss.ts — it rides only a
        // reported event), so a fixed one changes no byte on the wire.
        ...(config.capabilityMiss === undefined
          ? {}
          : { capabilityMiss: { config: config.capabilityMiss, intent: "" } }),
        options: { maxSteps: 1, maxOutputTokens: 1 },
        interactive: !isUnattended(input.ctx),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      // The provider's cache entry becomes readable only once the response has
      // streamed — drain the one-token body rather than cancelling the write
      // out from under itself.
      await response.text();
    },
  };
}
