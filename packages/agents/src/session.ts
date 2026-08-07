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
  type ThreadId,
  type ToolRegistry,
} from "@vendoai/core";
import type { VendoGuard } from "@vendoai/guard";
import { createHarnessRuntime, type HarnessRuntimeDeps } from "@vendoai/harnesses";
import {
  harnessStateStore,
  threadMessageStore,
  threadStore,
  workspaceStore,
  type VendoStore,
} from "@vendoai/store";
import type { UIMessage } from "ai";
import { randomUUID } from "node:crypto";
import { assemblePrompt } from "./prompt.js";

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
  const threads = threadStore(deps.store);
  let threadId: ThreadId;
  if (options.threadId === undefined) {
    threadId = `thr_${randomUUID()}` as ThreadId;
    await threads.put(principal, { id: threadId, messages: [] });
  } else {
    threadId = options.threadId as ThreadId;
    // `get` is scoped to the principal's own subject, so this is the ownership
    // check: a foreign thread reads back as absent and gets the same answer as
    // one that never existed. There is deliberately NO `put` on this leg — put
    // replaces the transcript with the `messages` it is handed, so the empty
    // array above would delete every turn we are here to read back.
    if (await threads.get(principal, threadId) === null) {
      throw new VendoError("not-found", `no conversation ${threadId} for this user`);
    }
  }

  const transcript = threadMessageStore<UIMessage>(deps.store);
  const workspaces = workspaceStore(deps.store, { files: deps.files });
  const runtime = () =>
    createHarnessRuntime({
      tools: deps.tools,
      guard: deps.guard,
      skills: createTurnSkills(workspace),
      transcript,
      harnessState: harnessStateStore(deps.store),
      ...(deps.liveTurn === undefined ? {} : { liveTurn: deps.liveTurn }),
    });
  // Opened at session start (the spec's "opens thread + workspace") and
  // reopened per turn below, so a turn always sees a fresh path index.
  let workspace = await workspaces.open(principal, { host: hostSkillFiles(deps.skills) });

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

      workspace = await workspaces.open(principal, { host: hostSkillFiles(deps.skills) });
      const directions = await deps.guard.directions(ctx);
      const system = assemblePrompt({
        ...(deps.instructions === undefined ? {} : { instructions: deps.instructions }),
        ...(options.user === undefined ? {} : { user: options.user }),
        ...(ctx.context === undefined ? {} : { situation: ctx.context }),
        directions,
      });

      return runtime().run({
        harness: deps.harness,
        threadId,
        messages,
        ctx,
        workspace,
        interactive: true,
        system,
        ...(streamOptions.signal === undefined ? {} : { signal: streamOptions.signal }),
      });
    },
  };
}
