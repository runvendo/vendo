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
  type ApprovalRequest,
  type FilesAdapter,
  type Harness,
  type Json,
  type PackSkill,
  type Principal,
  type ThreadId,
  type ToolRegistry,
} from "@vendoai/core";
import { createHarnessRuntime } from "@vendoai/harnesses";
import {
  harnessStateStore,
  threadMessageStore,
  threadStore,
  workspaceStore,
  type VendoStore,
} from "@vendoai/store";
import type { UIMessage } from "ai";
import { randomUUID } from "node:crypto";
import { relaxedModels, type EnrichedRunContext, type GuardLike } from "./pending-types.js";
import { assemblePrompt } from "./prompt.js";

export interface SessionOptions {
  /** Server-trust identity facts, model-visible (`[User]`). */
  user?: Record<string, Json>;
  /** Guard/tools context: functions run at check-time, data survives parking. */
  context?: Record<string, unknown>;
  /** Present-user auth forwarding — the request's own headers. */
  headers?: Record<string, string> | Headers;
}

export interface ApprovalEvent {
  request: ApprovalRequest;
  approve(): Promise<void>;
  deny(): Promise<void>;
}

export interface AgentSession {
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
  guard: GuardLike;
  /** Guard-bound already — the one choke point. */
  tools: ToolRegistry;
  skills: readonly PackSkill[];
  instructions?: string;
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
  const threadId = `thr_${randomUUID()}` as ThreadId;
  await threadStore(deps.store).put(principal, { id: threadId, messages: [] });

  const transcript = threadMessageStore<UIMessage>(deps.store);
  const workspaces = workspaceStore(deps.store, { files: deps.files });
  const runtime = () =>
    createHarnessRuntime({
      tools: deps.tools,
      guard: deps.guard,
      skills: createTurnSkills(workspace),
      transcript,
      harnessState: harnessStateStore(deps.store),
    });
  // Opened at session start (the spec's "opens thread + workspace") and
  // reopened per turn below, so a turn always sees a fresh path index.
  let workspace = await workspaces.open(principal, { host: hostSkillFiles(deps.skills) });

  const contextFor = (turnContext: Record<string, unknown> | undefined): EnrichedRunContext => ({
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
  const decide = async (request: ApprovalRequest, approve: boolean): Promise<void> => {
    if (deps.guard.approvals === undefined) return;
    await deps.guard.approvals.decide([request.id], { approve }, principal);
  };
  // P5's hook; feature-detected so today's guard still boots. Decisions
  // re-dispatch through the guard's own `onApprovalDecision` subscribers.
  deps.guard.onApprovalRequested?.((request) => {
    const event: ApprovalEvent = {
      request,
      approve: () => decide(request, true),
      deny: () => decide(request, false),
    };
    for (const handler of handlers) handler(event);
  });

  return {
    threadId,
    on(_event, handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async stream(message, streamOptions = {}) {
      const userMessage = asUserMessage(message);
      const persisted = await transcript.list(principal, threadId);
      const messages = [...persisted, userMessage];
      const ctx = contextFor(streamOptions.context);
      ctx.messages = messages;

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
        models: relaxedModels(),
        interactive: true,
        system,
        ...(streamOptions.signal === undefined ? {} : { signal: streamOptions.signal }),
      });
    },
  };
}
