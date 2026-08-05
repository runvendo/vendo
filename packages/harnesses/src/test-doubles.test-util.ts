/**
 * The minimum doubles this package's suites need for the seams siblings own.
 *
 * NOTE for the orchestrator: `packages/agent/src/test-helpers.ts` already holds
 * equivalent `testGuard` / `boundRegistry` / `ctx` doubles, but @vendoai/agent's
 * exports map has no subpath for them, so they are unreachable from another
 * package. Rather than edit a manifest this lane does not own, lane A carries
 * the slice it needs. A `"./test-helpers"` subpath on @vendoai/agent (the idiom
 * @vendoai/core/conformance and @vendoai/apps/adapter-conformance already set)
 * would let every lane share one copy.
 */
import type {
  ApprovalId,
  ApprovalRequest,
  AuditEvent,
  CommitResult,
  Guard,
  GuardDecision,
  Json,
  Principal,
  ResolvedModels,
  RunContext,
  SeatModels,
  SkillListing,
  ThreadId,
  ToolDescriptor,
  ToolOutcome,
  ToolRegistry,
  WorkspaceFs,
} from "@vendoai/core";
import type { LanguageModel, UIMessage } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { InMemoryFs } from "just-bash";

export function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    principal: { kind: "user", subject: "u1" },
    venue: "chat",
    presence: "present",
    sessionId: "s1",
    ...overrides,
  };
}

export function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

export type TestGuard = Guard & {
  events: AuditEvent[];
  /** Resolve a pending approval and notify subscribers, as the real guard does. */
  decide(approvalId: ApprovalId, approved: boolean): void;
  pending(): ApprovalRequest[];
};

/** `policy` maps a tool name to the guard's verdict; unlisted tools run. */
export function testGuard(policy: Record<string, "run" | "ask" | "block"> = {}): TestGuard {
  const approvalsByCall = new Map<string, ApprovalRequest>();
  const decisions = new Map<ApprovalId, boolean>();
  const subscribers = new Set<(id: ApprovalId, approved: boolean) => void>();
  const events: AuditEvent[] = [];

  const guard: TestGuard = {
    events,
    async check(call, descriptor, runCtx): Promise<GuardDecision> {
      const action = policy[call.tool] ?? "run";
      if (action === "run") return { action: "run", decidedBy: "default" };
      if (action === "block") return { action: "block", reason: "blocked", decidedBy: "rule" };
      let approval = approvalsByCall.get(call.id);
      if (approval === undefined) {
        approval = {
          id: `apr_${call.id}`,
          call: structuredClone(call),
          descriptor: structuredClone(descriptor),
          inputPreview: JSON.stringify(call.args),
          ctx: {
            principal: structuredClone(runCtx.principal),
            venue: runCtx.venue,
            presence: runCtx.presence,
          },
          createdAt: new Date().toISOString(),
        };
        approvalsByCall.set(call.id, approval);
      }
      const approved = decisions.get(approval.id);
      if (approved === true) return { action: "run", decidedBy: "default" };
      if (approved === false) return { action: "block", reason: "denied", decidedBy: "rule" };
      return { action: "ask", approval, decidedBy: "rule" };
    },
    async report(event) {
      events.push(structuredClone(event));
    },
    async directions() {
      return [];
    },
    onApprovalDecision(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    decide(approvalId, approved) {
      decisions.set(approvalId, approved);
      for (const subscriber of subscribers) subscriber(approvalId, approved);
    },
    pending() {
      return [...approvalsByCall.values()].filter((approval) => !decisions.has(approval.id));
    },
  };
  return guard;
}

export interface TestTool {
  descriptor: ToolDescriptor;
  execute(args: Json, ctx: RunContext): Json | Promise<Json>;
}

export type BoundRegistry = ToolRegistry & { invocations: Record<string, number> };

/** The guard-bound registry shape `VendoGuard.bind(tools)` returns: the one
 *  choke point every harness's calls pass through. */
export function boundRegistry(tools: Record<string, TestTool>, guard: Guard): BoundRegistry {
  const invocations: Record<string, number> = {};
  return {
    invocations,
    async descriptors() {
      return Object.values(tools).map(({ descriptor }) => structuredClone(descriptor));
    },
    async execute(call, runCtx) {
      const tool = tools[call.tool];
      if (tool === undefined) {
        return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
      }
      const decision = await guard.check(call, tool.descriptor, runCtx);
      let outcome: ToolOutcome;
      if (decision.action === "block") {
        outcome = { status: "blocked", reason: decision.reason };
      } else if (decision.action === "ask") {
        outcome = { status: "pending-approval", approvalId: decision.approval.id };
      } else {
        invocations[call.tool] = (invocations[call.tool] ?? 0) + 1;
        try {
          outcome = { status: "ok", output: await tool.execute(call.args, runCtx) };
        } catch (error) {
          outcome = {
            status: "error",
            error: { code: "execution", message: error instanceof Error ? error.message : String(error) },
          };
        }
      }
      await guard.report({
        id: `aud_${call.id}`,
        at: new Date().toISOString(),
        kind: "tool-call",
        principal: structuredClone(runCtx.principal),
        venue: runCtx.venue,
        presence: runCtx.presence,
        tool: call.tool,
        outcome: outcome.status,
        decidedBy: decision.decidedBy,
      });
      return outcome;
    },
  };
}

export function readTool(name: string, risk: ToolDescriptor["risk"] = "read"): ToolDescriptor {
  return {
    name,
    description: `the ${name} tool`,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    risk,
  };
}

/**
 * just-bash's real in-memory filesystem plus the §3.2 `commit`, STAGING writes
 * the way lane B's façade does: a write is visible to the façade's own reads
 * immediately but does not reach the store until `commit()`, which reports
 * exactly the changed paths. Never a home-rolled filesystem — the surface under
 * test is the real `IFileSystem`.
 */
export type TestWorkspace = WorkspaceFs & {
  commits: Array<{ message?: string; changed: string[] }>;
  /** Force the next commit to answer `conflict` for these paths (a stale base). */
  conflictOn?: string[];
  /** Paths the caller may READ but not write — the shape a viewer-level grant on
   *  an org app produces. The real façade answers this from `can()` against live
   *  rows; here it is stated, so a harness suite can pin the per-file behaviour
   *  without a store. */
  readOnlyPaths?: string[];
};

export function testWorkspace(files: Record<string, string> = {}): TestWorkspace {
  const fs = new InMemoryFs(files);
  const workspace = fs as unknown as TestWorkspace;
  const staged = new Set<string>();
  workspace.commits = [];

  /** The façade's own rule (`WorkspaceStoreFs.canCommit`): `/host` and anything
   *  outside the mounts are never writable; inside them the caller's grants
   *  decide, which `readOnlyPaths` stands in for. */
  workspace.canCommit = async (path: string): Promise<boolean> =>
    /^\/(?:user|orgs\/[^/]+)\//.test(path) && !(workspace.readOnlyPaths ?? []).includes(path);

  for (const method of ["writeFile", "appendFile"] as const) {
    const original = workspace[method].bind(workspace) as (...args: unknown[]) => Promise<void>;
    (workspace as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      await original(...args);
      staged.add(args[0] as string);
    };
  }

  workspace.commit = async (opts?: { message?: string }): Promise<CommitResult> => {
    const changed = [...staged];
    if (workspace.conflictOn !== undefined && workspace.conflictOn.length > 0) {
      const paths = workspace.conflictOn;
      workspace.conflictOn = [];
      return { status: "conflict", paths };
    }
    staged.clear();
    workspace.commits.push({ ...(opts?.message === undefined ? {} : { message: opts.message }), changed });
    return { status: "ok", changed };
  };
  return workspace;
}

export function testSkills(entries: Array<SkillListing & { body: string }> = []) {
  return {
    async list(): Promise<SkillListing[]> {
      return entries.map(({ name, description }) => ({ name, description }));
    },
    async load(name: string): Promise<string> {
      const entry = entries.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`no such skill: ${name}`);
      return entry.body;
    },
  };
}

/** Lane D's `threadMessageStore(store)` return value, in memory: one row per
 *  message, reassembled by seq. */
export function testTranscript() {
  const rows = new Map<string, Array<{ id: string; seq: number; message: UIMessage }>>();
  return {
    rows,
    async upsert(_principal: Principal, threadId: ThreadId, message: UIMessage, seq: number): Promise<void> {
      const thread = rows.get(threadId) ?? [];
      const existing = thread.findIndex((row) => row.id === message.id);
      const row = { id: message.id, seq, message: structuredClone(message) };
      if (existing === -1) thread.push(row);
      else thread[existing] = row;
      rows.set(threadId, thread);
    },
    async list(_principal: Principal, threadId: ThreadId): Promise<UIMessage[]> {
      return [...(rows.get(threadId) ?? [])]
        .sort((left, right) => left.seq - right.seq)
        .map((row) => structuredClone(row.message));
    },
  };
}

/** No seats at all — for the runtime suites, where the harness under test is
 *  scripted rather than a real loop. Honest now that `Turn.models` is a subset
 *  (`SeatModels`): a harness that DOES read a seat names the gap itself. */
export function unusedModels(): SeatModels<LanguageModel> {
  return {};
}

type StreamPart = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>["stream"] extends ReadableStream<
  infer Part
>
  ? Part
  : never;

export const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

export function textTurn(text: string, usage: typeof ZERO_USAGE = ZERO_USAGE): StreamPart[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", usage, finishReason: { unified: "stop", raw: undefined } },
  ];
}

export function toolCallTurn(toolName: string, input: unknown, toolCallId = "call_1"): StreamPart[] {
  return [
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
  ];
}

export type ScriptedModel = LanguageModel & { toolNamesPerCall: string[][]; calls: number };

/** A model that replays scripted provider chunks — so the harness's loop, not a
 *  real model, is what the suite measures. */
export function scriptedModel(turns: StreamPart[][]): ScriptedModel {
  const remaining = turns.map((turn) => [...turn]);
  const toolNamesPerCall: string[][] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      toolNamesPerCall.push((request.tools ?? []).map((tool) => tool.name));
      (model as ScriptedModel).calls += 1;
      const chunks = remaining.shift();
      if (chunks === undefined) throw new Error("scripted model exhausted");
      return { stream: simulateReadableStream({ chunks }) };
    },
  }) as unknown as ScriptedModel;
  model.toolNamesPerCall = toolNamesPerCall;
  model.calls = 0;
  return model;
}

/** `ResolvedModels` whose every seat is one scripted model. */
export function seats(model: LanguageModel): ResolvedModels<LanguageModel> {
  return { default: model, reviewer: model, judge: model, fill: model, verifier: model };
}

export async function readSse(response: Response): Promise<Array<Record<string, unknown>>> {
  const raw = await response.text();
  const blocks = raw.slice(0, -2).split("\n\n");
  return blocks
    .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
    .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);
}
