/**
 * One user's conversation — the ONLY file that touches `HarnessRuntime`.
 *
 * It resolves everything ctx-shaped (the enriched `RunContext`, the thread,
 * the workspace with its `/host/skills` projection, the per-turn system
 * prompt) and hands the existing runtime a `TurnRunInput`. Approval
 * checkpointing, byte-for-byte re-dispatch, and state persistence are the
 * runtime's and the guard's — INHERITED, not rebuilt.
 */
import {
  hostSkillFiles,
  createTurnSkills,
  VendoError,
  type ApprovalRequest,
  type FilesAdapter,
  type Harness,
  type Json,
  type Skill,
  type Principal,
  type RunContext,
  type SeatModels,
  type ThreadId,
  type ToolRegistry,
} from "@vendoai/core";
import { wrapWorkspaceForRender } from "@vendoai/apps";
import type { VendoGuard } from "@vendoai/guard";
import { createHarnessRuntime, THREAD_ID_HEADER, type HarnessRuntimeDeps } from "@vendoai/harnesses";
import {
  harnessStateStore,
  threadMessageStore,
  threadStore,
  workspaceStore,
  type VendoStore,
} from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { randomUUID } from "node:crypto";
import { assemblePrompt, type SystemPromptHook } from "./prompt.js";

export interface SessionOptions {
  /** Server-trust identity facts, model-visible (`[User]`). */
  user?: Record<string, Json>;
  /** Guard/tools context: functions run at check-time, data survives parking. */
  context?: Record<string, unknown>;
  /** Present-user auth forwarding — the request's own headers. */
  headers?: Record<string, string> | Headers;
  /** Reopen the conversation with this id instead of starting a new one. A
   *  session is a request-lifetime object; the thread is what outlives it, so
   *  this id is what a Node backend hands back to reach the same conversation
   *  on the next request. Not this subject's thread (or not a thread at all) is
   *  `not-found` — never a silent new conversation. */
  threadId?: string;
}

/** `respond()`'s options: a session's, plus the per-turn cancellation a
 *  one-shot call has nowhere else to put. */
export interface RespondOptions extends SessionOptions {
  signal?: AbortSignal;
}

/** What a caller is told when the id they handed back is not a conversation
 *  this subject owns. ONE sentence for both lanes — `session({ threadId })`
 *  and `run({ threadId })` reopen the same threads. */
const unknownThreadMessage = (threadId: string): string =>
  `No conversation ${threadId} for this user. Pass a threadId this subject started `
  + `— the one the last turn returned on ${THREAD_ID_HEADER} — or omit it to start a new one.`;

/**
 * Mint a new conversation, or reopen the one this subject already owns.
 *
 * `get` is scoped to the principal's own subject, so it IS the ownership check:
 * a foreign thread reads back as absent and gets the same answer as one that
 * never existed. There is deliberately NO `put` on the reopen leg — put
 * replaces the transcript with the `messages` it is handed, so an empty array
 * would delete every turn the caller came back to read.
 */
export async function openThread(
  store: VendoStore,
  principal: Principal,
  threadId: ThreadId,
  reopen: boolean,
): Promise<void> {
  const threads = threadStore(store);
  if (!reopen) {
    await threads.put(principal, { id: threadId, messages: [] });
    return;
  }
  if (await threads.get(principal, threadId) === null) {
    throw new VendoError("not-found", unknownThreadMessage(threadId));
  }
}

export interface ApprovalEvent {
  request: ApprovalRequest;
  approve(): Promise<void>;
  deny(): Promise<void>;
}

export interface AgentSession {
  /** The conversation this session is on. Hand it back as
   *  `session(subject, { threadId })` to reopen the same conversation later. */
  readonly threadId: string;
  /** One turn; an AI-SDK UI-message stream `Response` (approval parts included). */
  stream(
    message: string | UIMessage,
    options?: { context?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<Response>;
  on(event: "approval", handler: (req: ApprovalEvent) => void): () => void;
}

export interface SessionDeps {
  name: string;
  harness: Harness<unknown>;
  store: VendoStore;
  files: FilesAdapter;
  guard: VendoGuard;
  /** Guard-bound already — the one choke point. */
  tools: ToolRegistry;
  skills: readonly Skill[];
  instructions?: string;
  /** The seats a harness that does NOT bring its own brain reads (`vendo()`). */
  models?: SeatModels<LanguageModel>;
  /** The host's last word on the turn's prompt — see `AgentConfig.system`. */
  system?: SystemPromptHook;
  /** Publish the turn in flight to the agent's own MCP door (`door.ts`). A
   *  harness that thinks outside this process mints a credential pointing at
   *  "the turn now live on thread T"; without this the pointer resolves to
   *  nothing and every tool call it makes is a 401. */
  liveTurn?: HarnessRuntimeDeps["liveTurn"];
  /** A loopback door still binding its port. Awaited here, once, so no turn
   *  can ever read the door's URL mid-bind. */
  doorReady?: Promise<void>;
}

const toHeaderRecord = (
  headers: Record<string, string> | Headers | undefined,
): Record<string, string> | undefined => {
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return headers;
};

const asUserMessage = (message: string | UIMessage): UIMessage =>
  typeof message === "string"
    ? { id: `msg_${randomUUID()}`, role: "user", parts: [{ type: "text", text: message }] }
    : message;

export async function createSession(
  deps: SessionDeps,
  subject: string,
  options: SessionOptions = {},
): Promise<AgentSession> {
  const principal: Principal = { kind: "user", subject };
  const requestHeaders = toHeaderRecord(options.headers);

  await deps.store.ensureSchema();
  await deps.doorReady;
  const threadId = (options.threadId ?? `thr_${randomUUID()}`) as ThreadId;
  await openThread(deps.store, principal, threadId, options.threadId !== undefined);

  const transcript = threadMessageStore<UIMessage>(deps.store);
  const workspaces = workspaceStore(deps.store, { files: deps.files });
  // Opened once per turn, in `stream()` below, so a turn always sees a fresh
  // path index — and passed in rather than held on the session, so two
  // `stream()` calls in flight on one session cannot read each other's.
  const runtime = (workspace: Awaited<ReturnType<typeof workspaces.open>>) =>
    createHarnessRuntime({
      tools: deps.tools,
      guard: deps.guard,
      skills: createTurnSkills(workspace),
      transcript,
      harnessState: harnessStateStore(deps.store),
      // §1.6 — the render seam, on the runtime's generic `wrapWorkspace` slot:
      // a commit that lands `app.vendo`/`plan.vendo` paints, whichever hands
      // wrote it (`claudeCode()` commits mid-turn through `turn.workspace`).
      // BARE — no floor, no app half — because this standalone runtime composes
      // no apps runtime to fill them; the umbrella's composition does
      // (`packages/vendo/src/harness-turn.ts`).
      wrapWorkspace: (turnWorkspace, opts) => wrapWorkspaceForRender(turnWorkspace, {
        turnId: opts.turnId,
        emit: opts.emit,
      }),
      ...(deps.liveTurn === undefined ? {} : { liveTurn: deps.liveTurn }),
    });

  const contextFor = (turnContext: Record<string, unknown> | undefined): RunContext => ({
    principal,
    venue: "chat",
    presence: "present",
    sessionId: threadId,
    ...(requestHeaders === undefined ? {} : { requestHeaders }),
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.context === undefined && turnContext === undefined
      ? {}
      : { context: { ...options.context, ...turnContext } }),
  });

  const handlers = new Set<(req: ApprovalEvent) => void>();
  const decide = (request: ApprovalRequest, approve: boolean): Promise<void> =>
    deps.guard.approvals.decide([request.id], { approve }, principal);
  // The guard is SHARED across every session on this agent, and it stamps each
  // parked approval with the RunContext's sessionId — this thread. Only that
  // conversation may see (or resolve, via the closures below) its approvals;
  // an ownerless request matches no thread, so delivery fails closed.
  // Decisions re-dispatch through the guard's own `onApprovalDecision` subscribers.
  const deliver = (request: ApprovalRequest): void => {
    if (request.ctx.sessionId !== threadId) return;
    const event: ApprovalEvent = {
      request,
      approve: () => decide(request, true),
      deny: () => decide(request, false),
    };
    for (const handler of handlers) handler(event);
  };
  let unsubscribe: (() => void) | undefined;

  return {
    threadId,
    on(_event, handler) {
      handlers.add(handler);
      unsubscribe ??= deps.guard.onApprovalRequested(deliver);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },
    async stream(message, streamOptions = {}) {
      const userMessage = asUserMessage(message);
      const persisted = await transcript.list(principal, threadId);
      const messages = [...persisted, userMessage];
      // `ctx.messages` (the frozen accessor) is the runtime's to attach — it
      // resolves the thread and freezes the canonical copy.
      const ctx = contextFor(streamOptions.context);

      const workspace = await workspaces.open(principal, { host: hostSkillFiles(deps.skills) });
      const directions = await deps.guard.directions(ctx);
      const assembled = assemblePrompt({
        ...(deps.instructions === undefined ? {} : { instructions: deps.instructions }),
        ...(options.user === undefined ? {} : { user: options.user }),
        ...(ctx.context === undefined ? {} : { situation: ctx.context }),
        directions,
      });
      const system = deps.system === undefined
        ? assembled
        : (await deps.system(ctx, { assembled, directions })) ?? assembled;

      const response = await runtime(workspace).run({
        harness: deps.harness,
        threadId,
        messages,
        ctx,
        workspace,
        interactive: true,
        system,
        ...(deps.models === undefined ? {} : { models: deps.models }),
        ...(streamOptions.signal === undefined ? {} : { signal: streamOptions.signal }),
      });
      // The conversation's id, on the response the caller is already holding —
      // the same header the umbrella's wire stamps and `@vendoai/ui` reads, so a
      // browser talking to an `agent()` backend resumes exactly as it does
      // against `createVendo`.
      response.headers.set(THREAD_ID_HEADER, threadId);
      return response;
    },
  };
}
