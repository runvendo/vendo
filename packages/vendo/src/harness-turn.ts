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
  STORE_WIRE_TURN_OPS,
  isVendoError,
  VendoError,
  createTurnSkills,
  emitUsage,
  hostSkillFiles,
  isUnattended,
  situationPromptBlock,
  toVendoWirePart,
  WARM_THREAD_PREFIX,
  type FilesAdapter,
  type Harness,
  type Membership,
  type Skill,
  type Principal,
  type RecordInput,
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
import { deriveTitle, isThreadId, mintThreadId, ThreadRepository, type Thread, type ThreadSummary } from "./threads.js";
import {
  HOT_PATH_WATCH,
  hotPathAppId,
  repairInstruction,
  validateWrittenApps,
  wrapWorkspaceForRender,
  type RenderSeamOptions,
} from "@vendoai/apps";
import type { VendoGuard } from "@vendoai/guard";
import {
  harnessStateKey,
  harnessStateRow,
  harnessStateStore,
  maybeDbFor,
  threadMessageStore,
  workspaceIndexPage,
  workspaceStore,
  type VendoStore,
} from "@vendoai/store";
import {
  createHarnessRuntime,
  createTurnTimings,
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
import { createUIMessageStream, createUIMessageStreamResponse, type LanguageModel, type UIMessage } from "ai";
import { discoveryRail } from "./prompt.js";
import { finishActiveTurn } from "./turn-liveness.js";
import { isUserFilePath, userFilePath } from "./user-files.js";
import type { Limiter } from "./limits.js";

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
   *  and for the same reason: the floor runs the screen's queries as the CALLER,
   *  so it needs this turn's ctx. Wired into the runtime's generic
   *  `wrapWorkspace` slot below — the runtime itself no longer knows the seam. */
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
  /** The host's `limits` policy, bound to the meter (limits.ts). Unset — the
   *  host set no policy — and the turn below costs one undefined check. */
  limiter?: Limiter;
}

/** Where a file the user shared landed, and how big it was. The path is the
 *  whole handle: the drawer is the workspace, so anything that can open the
 *  workspace can reach the bytes again. */
export interface UploadedFile {
  path: string;
  bytes: number;
}

/**
 * What the MODEL is handed for a file the user shared.
 *
 * A drawer part carries a PATH, not bytes — that is what keeps the transcript
 * light — and a provider handed a path where it expects file data reads it as
 * base64 and thinks about garbage. So a saved file reaches the model as a line
 * of text naming it and where it landed. Images are left exactly as they are:
 * they ride inline, because that is how vision works.
 *
 * The STORED transcript is untouched. This maps the copy the runtime thinks
 * with, and the runtime writes back only the messages its own turn changed, so
 * the part the surface draws its pill from stays the part that was persisted.
 */
const withFileReferences = (messages: readonly UIMessage[]): UIMessage[] =>
  messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => (
      part.type === "file" && !part.mediaType.startsWith("image/") && isUserFilePath(part.url)
        ? { type: "text" as const, text: `The user shared ${part.filename ?? "a file"}, saved at ${part.url}` }
        : part
    )),
  })) as UIMessage[];

/**
 * Composition's word that this turn's opening WRITE needs nothing from its
 * opening read — which is what lets the two go out together instead of one
 * behind the other.
 *
 * It asserts two things at once, and both have to hold: the message was authored
 * by THIS process rather than posted by a client (so `validateUpsert` has no
 * history to protect), and `threadId` came off a row that only carries one
 * because a turn already ran on it (so the thread exists and already holds the
 * title the append would otherwise have to derive from the read).
 *
 * A SYMBOL, and not exported from the package, because those two claims can only
 * be made by code that watched them become true. `JSON.parse` cannot produce a
 * symbol key, so no request body can carry it however a door is later written,
 * and no host can reach it. The one caller is `runChannelTurn`.
 */
export const SERVER_AUTHORED = Symbol("vendo.turn.serverAuthored");

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
    readonly [SERVER_AUTHORED]?: true;
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
  /** Put a file in one user's drawer — THE server-side write, shared by the
   *  upload door (`POST /files`) and by `vendo.putUserFile`, so a file pushed
   *  from host code is indistinguishable from one the user dropped in chat.
   *
   *  Same name as an existing file REPLACES it: `/user` is last-write-wins
   *  (build contract §3.2), which is what makes "here is the newer export" work
   *  without the user naming files v2, v3, v4.
   *
   *  The door's 5 MiB cap is the DOOR's, not this write's — a trusted caller is
   *  bounded by whatever backs the `files:` adapter (unset: the store's blobs,
   *  up to FILES_STORE_MAX_BYTES). `contentType` is advisory: the drawer stores
   *  bytes, and what the file IS travels with its name's extension. */
  putUserFile(input: {
    principal: Principal;
    name: string;
    content: Uint8Array | string;
    contentType?: string;
  }): Promise<UploadedFile>;
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

/** The whole of a message the host's policy refused: the card the chat surface
 *  renders, and nothing else. No thread row, no transcript, no model call — the
 *  point of the choke is that a denied message costs nothing. */
const limitResponse = (verdict: { message?: string; retryable?: true }): Response => createUIMessageStreamResponse({
  stream: createUIMessageStream<UIMessage>({
    execute: ({ writer }) => {
      writer.write(toVendoWirePart({
        type: "data-vendo-limit",
        ...(verdict.message === undefined ? {} : { message: verdict.message }),
        ...(verdict.retryable === undefined ? {} : { retryable: verdict.retryable }),
      }) as never);
    },
  }),
});

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
   * Does this deployment's store serve the turn envelopes? ONE answer per
   * deployment, asked EXPLICITLY before the first send — the shape
   * `servesAppendMessages` uses, and deliberately not a `catch` around a failed
   * batch (#1251).
   *
   * Two mounts answer no and mean it. A store with a SQL handle is already ONE
   * HOP from its rows, so there is no round trip to batch away and its doors
   * stay exactly as they are. A mount below the level is served by the
   * individual calls every caller started with — and that fallback is not
   * cosmetic: the runtime's closing writes carry a retry and a per-write
   * isolation (a lost session must never cost the transcript) that one batched
   * write cannot express.
   *
   * A handshake that fails is not an answer — it is not cached, and the turn
   * takes the per-op path rather than failing.
   */
  let turnLevel: Promise<boolean> | undefined;
  const servesTurn = async (): Promise<boolean> => {
    const ops = config.store.ops;
    if (ops?.turn === undefined || maybeDbFor(config.store) !== undefined) return false;
    if (turnLevel === undefined) {
      turnLevel = ops.status().then((status) => status.ops >= STORE_WIRE_TURN_OPS);
      turnLevel.catch(() => { turnLevel = undefined; });
    }
    return await turnLevel.catch(() => false);
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

    async putUserFile(input) {
      const path = userFilePath(input.name);
      const bytes = typeof input.content === "string"
        ? new TextEncoder().encode(input.content)
        : input.content;
      // The user's OWN mount and nothing else: no host projection to build and
      // no org mounts to assert, because a drawer write addresses one subject.
      const workspace = await sqlDoors().workspaces.open(input.principal);
      await workspace.writeFile(path, bytes);
      await workspace.commit();
      return { path, bytes: bytes.byteLength };
    },

    async stream(input) {
      // The turn's clock, started at the top: `durationMs` used to begin after
      // the opening reads, which is why a slow store was invisible in it.
      const timings = createTurnTimings();
      validateMessage(input?.message);
      // The message choke (limits.ts owns the counting, the policy and the
      // recording): asked BEFORE the thread is resolved, so a refused message
      // costs no read, no write and no model call.
      const verdict = await config.limiter?.gate("message", input.ctx);
      if (verdict?.allow === false) return limitResponse(verdict);
      // Assembled once, per turn, for WHOEVER thinks. The venue gate and the guard's
      // directions live in here, which is why it is composition's job and not the
      // harness's. Which discovery section it may promise is decided by what is
      // actually on the listing: a curated surface has `find_tools`, an uncurated one
      // has the connector pair (and only with connectors configured), or neither.
      //
      // STARTED HERE and awaited after the store phase. It needs only the
      // request's ctx and the rail this harness carries — neither of which the
      // store below can change — so assembling it after the reads meant the turn
      // paid the store's wait and the guard's `directions` wait end to end.
      // Started after the limiter gate, not before: a refused message must still
      // cost nothing.
      const rail = discoveryRail(config.harness, config.connectorDiscovery);
      const systemRead = config.system(input.ctx, { discovery: rail });
      // A rejection is delivered where the prompt is awaited below; this only
      // keeps a store-phase throw from turning it into an unhandled one.
      void systemRead.catch(() => {});
      // The turn's opening reads, in ONE call where the store serves it: the
      // thread row, the workspace index, and the harness slot. Each part is
      // exactly what its own op answers, so the doors below decide on the same
      // rows they would have read one call at a time — this skips the READS and
      // nothing else. Unserved, `loaded` is undefined and every door reads for
      // itself, exactly as it always has.
      //
      // The id is minted HERE when the caller brought none: a turn has to name
      // its thread before it can ask for it, and a first turn still has a
      // workspace to read. A malformed one is refused by `resolve` below
      // without costing a read, which is what it always cost.
      const given = input.threadId as ThreadId | undefined;
      const { subject } = input.ctx.principal;
      // The store phase: the handshake, the envelope read, the thread resolve,
      // the opening write and the workspace open — everything before the prompt
      // is assembled. One span, because it is one wait for the person.
      const storeAt = Date.now();
      const batched = (given === undefined || isThreadId(given)) && await servesTurn();
      // Minted HERE only when the envelope will ask for it: a turn has to name
      // its thread before it can read it, and a first turn still has a
      // workspace to read. Unbatched, `resolve` mints exactly as it always did
      // — a fresh id must not cost a read for a row that cannot exist.
      const threadId = given ?? mintThreadId();
      // The opening WRITE, in flight WITH the opening read rather than behind
      // it. It is only ever sent here because SERVER_AUTHORED says the two
      // things that make the read's answer irrelevant to it: no title to derive
      // (the thread already has one) and no history to guard (nothing came from
      // a client). The append itself still enforces ownership in its own
      // statement, so a link pointing at another subject's thread is refused
      // here exactly as it always was. Below the turn level there is no round
      // trip worth saving, so the old order stands.
      const opening = input[SERVER_AUTHORED] === true && given !== undefined && batched
        ? sqlDoors().transcript.upsertMany?.(input.ctx.principal, given, [input.message], {})
        : undefined;
      // A rejection is delivered where it is awaited below; this only keeps a
      // slow read from turning it into an unhandled one first.
      void opening?.catch(() => {});
      const loaded = batched
        ? await config.store.ops!.turn!.load({
          thread: { id: threadId },
          index: { owner: subject },
          // The slot is keyed by the thread's OWNER. A thread that is not this
          // caller's reads as a missing slot and is refused by `resolve`
          // moments later, so the guess is either right or discarded.
          harness: { appId: harnessStateKey(threadId), subject },
        })
        : undefined;
      // The thread is resolved through the SHIPPED repository: same id pattern,
      // same "already in use" refusal for a foreign thread, same title
      // derivation — and `thread.messages` is the canonical transcript read back
      // from `vendo_thread_messages`.
      const thread = await threads.resolve(batched ? threadId : given, input.ctx, loaded?.thread);

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
      // Skipped only where it can protect nothing: an already-sent opening write
      // carries a message this process authored, so there is no client copy to
      // check it against — and a gate run after the write could only report a
      // rewrite it had already let through.
      if (opening === undefined) validateUpsert(thread.messages, input.message);
      upsertMessage(thread.messages, input.message);

      // Before the FIRST write, not after it. `threads.persist` goes through the
      // adapter seam and so succeeds even on a store that can keep neither the
      // transcript nor the workspace — so resolving the doors any later makes the
      // refusal a half-write, leaving a `vendo_threads` row carrying the user's
      // message on a deployment that can never answer it.
      const { transcript, workspaces, harnessState } = sqlDoors();
      // The batch verb, read as OPTIONAL on purpose — its type says it is always
      // there, and a `@vendoai/store` older than it says otherwise at runtime.
      // The group ships lockstep, so that takes pinning the packages
      // individually (or a stale build), but an unguarded call turns it into a
      // hard failure on turn TWO of a conversation, and `persistTurn` in
      // `@vendoai/harnesses` already guards the same verb the same way. One
      // policy for it, not two.
      const batchAppend: typeof transcript.upsertMany | undefined = transcript.upsertMany;
      const index = loaded !== undefined && (input.ctx.memberships ?? []).length === 0
        ? workspaceIndexPage(loaded.index, subject)
        : undefined;

      // The turn's store reads, IN FLIGHT TOGETHER (sub-1s shipment): the state
      // read needs nothing below, and `resolve()` already read the thread row —
      // subject included — so it skips its own owner lookup. Read-only, so a
      // turn the runtime later refuses has spent a read and changed nothing.
      const stateRead = loaded === undefined
        ? harnessState.get(thread.id, config.harness.name, thread.subject)
        // `resume` IS `get`'s second half — same §1.3 rules, including a foreign
        // harness DESTROYING the slot — against the row already in hand.
        : harnessState.resume(thread.id, config.harness.name, loaded.harness, thread.subject);
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
        // `persist` also serves as the fallback when the store predates the
        // batch verb: it is exactly what this call site did before the verb
        // existed, and unlike a bare `upsert` it still refreshes the listing
        // title and `updated_at`. So a turn on an older store is slower, not
        // broken.
        // Already in flight since before the read, where it was allowed to be.
        opening
        ?? (fresh || batchAppend === undefined
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
          )),
        // §9.7 — the turn's façade mounts every org the wire asserted for this
        // request, so an agent turn can read and write the team's files at all.
        workspaces.open(input.ctx.principal, {
          host: hostProjection(),
          ...(input.ctx.memberships === undefined ? {} : { memberships: input.ctx.memberships }),
          // The index the envelope read, when it covers this caller's whole
          // mount set — one owner, and a page that finished. An org turn (§9.7)
          // reads one index per asserted org, so it keeps the fan-out; a page
          // that left a cursor behind is refused by `workspaceIndexPage`,
          // because half an index is a workspace missing files.
          ...(index === undefined ? {} : { index }),
        }),
      ]);
      timings.add("store", Date.now() - storeAt);
      // §1.6 — the render seam, built for THIS turn's ctx and handed to the
      // runtime's generic `wrapWorkspace` slot: the runtime owns WHERE the wrap
      // happens and what `emit` writes to; composition owns WHAT wraps.
      const render = config.render === undefined ? undefined : config.render(input.ctx);
      // The turn's own SHAPE, counted on the two rails this file already owns:
      // every tool call passes the bridge's `onCall`, and `liveTurn`'s disposer
      // is the runtime's turn end (it retracts the publication in the run's
      // `finally`). Names and counts only — no argument and no result.
      const toolNames = new Set<string>();
      let toolCalls = 0;
      const emitRun = (outcome: "ok" | "error", errorCode: string | null): void => {
        const durationMs = timings.elapsed();
        const { ttft = 0, store = 0, prompt = 0, tools: toolsMs = 0, guard = 0 } = timings.ms;
        emitUsage({
          name: "agent_run",
          durationMs,
          ttftMs: ttft,
          storeMs: store,
          promptMs: prompt,
          // Whatever the other four leave over — the thinker's own wall time,
          // which is what a slow turn is usually made of.
          modelMs: Math.max(0, durationMs - store - prompt - toolsMs - guard),
          toolsMs,
          guardMs: guard,
          steps: timings.steps,
          toolCalls,
          tools: [...toolNames].sort(),
          modelFamily: modelFamilyOf(config.models),
          outcome,
          errorCode,
        });
      };
      // ONE array, handed to the runtime as BOTH its history and its messages.
      //
      // Two things depend on that being one object rather than two equal ones.
      // The runtime skips re-validating the transcript against itself only when
      // the two are identical (`before === input.messages`, runtime.ts) — a
      // copy, however equal, spends an O(n) double stringify proving a
      // tautology. And a saved file must reach the model as a reference in BOTH
      // of them: rewrite only one and the runtime's history-forgery guard sees
      // two renderings of one message and reads it as the client rewriting a
      // message nobody rewrote.
      //
      // Nothing here is written through: the runtime deep-copies both the
      // canonical transcript and the pristine snapshot it diffs persistence
      // against. And because it then writes back only what the turn CHANGED,
      // the stored file part — the one the surface draws its pill from — is
      // never replaced by the reference text the model read.
      const modelMessages = withFileReferences(thread.messages);
      const bridge = config.bridge?.(input.ctx, thread.id) as ToolBridgeOptions | undefined;
      const runtime = createHarnessRuntime({
        tools: config.tools,
        guard: config.guard,
        // The same collector the marks above went into: the runtime adds the
        // ones only it can see (the first output, the model calls).
        timings,
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
          // The ARRAY the turn is running, not a copy of it. The runtime takes
          // its own deep copies of both the canonical transcript and the
          // pristine one it diffs persistence against, so it never writes
          // through this — and handing it the same array is what lets it SEE
          // that its stored history and its incoming history are one thing, and
          // skip re-validating the transcript against itself (runtime.ts).
          list: async (principal, threadId) =>
            threadId === thread.id && principal.subject === thread.subject
              ? modelMessages
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
            // The same moment, said to the wire: the thinker is done, so the
            // client-idle watchdog must not abort what is left (the workspace
            // commit, the transcript, the audit row). By turn, never by thread —
            // a sibling turn on this thread is still streaming. The runtime
            // always resolves one (`started.ctx.turnId ?? mintTurnId()`).
            finishActiveTurn(published.ctx.turnId!);
          };
        },
        // The turn's closing writes as ONE call, where the store serves it: the
        // messages, the harness state to carry into the next turn, and the
        // run's audit row, landed together. Unset, the runtime writes the three
        // it always wrote — the fallback lives there, with its retry and its
        // per-write isolation, and this slot never touches it.
        ...(!batched ? {} : {
          commitTurn: async ({ messages, state, audit }) => {
            // The audit row comes from the GUARD's own door, never rebuilt
            // here: `reportThrough` normalises and meters exactly as `report`
            // does and hands the row over instead of writing it. A guard that
            // omits the seam writes it the way every caller started.
            let row: { collection: string; record: RecordInput } | undefined;
            if (audit !== undefined) {
              await config.guard.reportThrough?.(audit, async (collection, record) => {
                row = { collection, record };
              });
            }
            await config.store.ops!.turn!.commit({
              messages: { threadId: thread.id, subject: thread.subject, messages },
              ...(state === undefined ? {} : {
                harness: {
                  appId: harnessStateKey(thread.id),
                  subject: thread.subject,
                  state: harnessStateRow(config.harness.name, state),
                },
              }),
              ...(row === undefined ? {} : { audit: row }),
            });
            // The row the envelope could not carry still lands — one extra
            // call, and never a lost run row.
            if (audit !== undefined && row === undefined) await config.guard.report(audit);
          },
        }),
      });

      // What the prompt still COSTS the turn, now that it was assembled beside
      // the store phase: the wait left over once the reads are done. The phase
      // split has to keep summing to the wall clock (`modelMs` is the
      // remainder), so an overlapped span must be billed once, to whichever
      // phase was still waiting — and a prompt that finished first is honestly
      // worth ~0ms to this turn.
      const promptAt = Date.now();
      const system = await systemRead;
      // Spec 2026-08-05 §2, relocated (sub-1s shipment): the screen snapshot is
      // delivered BESIDE the stable prompt, not inside it — it changes every
      // message, and volatile bytes ahead of stable ones are what kept the
      // provider's prompt cache cold. Same block builder, same this-turn-only
      // life: the ctx and `Turn.situation`, never the store.
      const situation = situationPromptBlock(input.ctx.context);
      timings.add("prompt", Date.now() - promptAt);
      const response = await runtime.run<never>({
        harness: config.harness,
        threadId: thread.id,
        messages: modelMessages,
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
        emitRun("error", isVendoError(error) ? error.code : "unknown");
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
      const rail = discoveryRail(config.harness, config.connectorDiscovery);
      const system = await config.system(input.ctx, { discovery: rail });
      const response = await runtime.run<{ maxSteps: number; maxOutputTokens: number }>({
        harness: config.harness,
        threadId: `${WARM_THREAD_PREFIX}${globalThis.crypto.randomUUID().replaceAll("-", "")}` as ThreadId,
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
