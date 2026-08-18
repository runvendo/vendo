/**
 * The doubles the tool-pack suites need: a test guard and a guard-bound registry.
 *
 * A copy, deliberately: `@vendoai/harnesses` keeps its own equivalent
 * (`test-doubles.test-util.ts`) rather than either package publishing a
 * test-only subpath, which is surface nobody asked for. The alternative — a
 * shared doubles package — would be a package for two callers.
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
  ToolCall,
  ToolDescriptor,
  ToolOutcome,
  ToolRegistry,
  WorkspaceFs,
} from "@vendoai/core";
import type { LanguageModel, UIMessage } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { InMemoryFs } from "just-bash";
export type TestGuard = Guard & {
  events: AuditEvent[];
  directionValues: string[];
  /** AGENT-6: approval ids resolved through abandonApprovals, in call order. */
  abandoned: ApprovalId[];
  decide(approvalId: ApprovalId, approved: boolean): void;
  pending(): ApprovalRequest[];
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function testGuard(
  policy: Record<string, "run" | "ask" | "block"> = {},
  directions: string[] = [],
): TestGuard {
  const approvalsByCall = new Map<string, ApprovalRequest>();
  const decisions = new Map<ApprovalId, boolean>();
  const subscribers = new Set<(id: ApprovalId, approved: boolean) => void>();
  const events: AuditEvent[] = [];
  const directionValues = [...directions];

  const guard: TestGuard = {
    events,
    directionValues,
    abandoned: [],
    // AGENT-6: mirror the real guard — abandoning denies each still-pending
    // approval (idempotent; unknown/decided ids are no-ops) and notifies
    // decision subscribers.
    async abandonApprovals(ids) {
      for (const id of ids) {
        const known = [...approvalsByCall.values()].some((approval) => approval.id === id);
        if (!known || decisions.has(id)) continue;
        guard.abandoned.push(id);
        guard.decide(id, false);
      }
    },
    async check(call, descriptor, runCtx): Promise<GuardDecision> {
      const action = policy[call.tool] ?? "run";
      if (action === "run") return { action: "run", decidedBy: "default" };
      if (action === "block") return { action: "block", reason: "blocked", decidedBy: "rule" };

      let approval = approvalsByCall.get(call.id);
      if (approval === undefined) {
        approval = {
          id: `apr_${call.id}`,
          call: structuredClone(call),
          descriptor: deepFreeze(structuredClone(descriptor)),
          inputPreview: JSON.stringify(call.args),
          ctx: {
            principal: structuredClone(runCtx.principal),
            venue: runCtx.venue,
            presence: runCtx.presence,
            ...(runCtx.appId === undefined ? {} : { appId: runCtx.appId }),
            ...(runCtx.trigger === undefined ? {} : { trigger: structuredClone(runCtx.trigger) }),
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
      return [...directionValues];
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

export interface TestToolImplementation {
  descriptor: ToolDescriptor;
  execute(args: Json, ctx: RunContext, call: ToolCall): Json | Promise<Json>;
}

export type BoundRegistry = ToolRegistry & {
  invocations: Record<string, number>;
};

export function boundRegistry(
  implementations: Record<string, TestToolImplementation>,
  guard: Guard,
): BoundRegistry {
  const invocations = Object.fromEntries(
    Object.keys(implementations).map((name) => [name, 0]),
  ) as Record<string, number>;

  return {
    invocations,
    async descriptors() {
      return Object.values(implementations).map(({ descriptor }) => structuredClone(descriptor));
    },
    async execute(call, runCtx) {
      const implementation = implementations[call.tool];
      if (implementation === undefined) {
        return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
      }

      const decision = await guard.check(call, implementation.descriptor, runCtx);
      let outcome: ToolOutcome;
      if (decision.action === "block") {
        outcome = { status: "blocked", reason: decision.reason };
      } else if (decision.action === "ask") {
        outcome = { status: "pending-approval", approvalId: decision.approval.id };
      } else {
        invocations[call.tool] = (invocations[call.tool] ?? 0) + 1;
        try {
          outcome = { status: "ok", output: await implementation.execute(call.args, runCtx, call) };
        } catch (error) {
          outcome = {
            status: "error",
            error: {
              code: "execution",
              message: error instanceof Error ? error.message : String(error),
            },
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
        ...(runCtx.appId === undefined ? {} : { appId: runCtx.appId }),
        ...(runCtx.trigger === undefined ? {} : { trigger: structuredClone(runCtx.trigger) }),
        tool: call.tool,
        inputPreview: JSON.stringify(call.args),
        outcome: outcome.status,
        decidedBy: decision.decidedBy,
      });
      return outcome;
    },
  };
}

// The core conformance kit ships the reference in-memory StoreAdapter; tests
// exercise the same double every other block will use.
export function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    principal: { kind: "user", subject: "u1" },
    venue: "chat",
    presence: "present",
    sessionId: "s1",
    ...overrides,
  };
}

// ── The doubles the screen-agent suites arrived with (the agent moved home
// here from `@vendoai/harnesses`, whose test-doubles file keeps the same set).

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
   *  an org app produces. */
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

export type StreamPart = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>["stream"] extends ReadableStream<
  infer Part
>
  ? Part
  : never;

export const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

/** What a `finish` part carries. Named off the part rather than off
 *  `ZERO_USAGE`, whose `as const` would pin every caller to zeros. */
type StreamUsage = Extract<StreamPart, { type: "finish" }>["usage"];

export function textTurn(text: string, usage: StreamUsage = ZERO_USAGE): StreamPart[] {
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

export type ScriptedModel = LanguageModel & {
  toolNamesPerCall: string[][];
  /** What each call actually SENT — the only place a suite can prove what the
   *  loop's history assembly did or did not include. */
  prompts: unknown[];
  /** The system message of each call, so a suite can assert on the BRIEF a loop
   *  assembled without reaching into the loop to get it. */
  systemPrompts: string[];
  /** The provider options each call carried. Per-role model parameters are set on
   *  the MODEL INSTANCE (middleware), so what reaches the provider is the only
   *  place a suite can read them. */
  providerOptionsPerCall: Array<Record<string, unknown> | undefined>;
  calls: number;
};

/** A model that replays scripted provider chunks — so the loop under test, not
 *  a real model, is what the suite measures. */
export function scriptedModel(turns: StreamPart[][]): ScriptedModel {
  const remaining = turns.map((turn) => [...turn]);
  const toolNamesPerCall: string[][] = [];
  const prompts: unknown[] = [];
  const systemPrompts: string[] = [];
  const providerOptionsPerCall: Array<Record<string, unknown> | undefined> = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      toolNamesPerCall.push((request.tools ?? []).map((tool) => tool.name));
      prompts.push(structuredClone(request.prompt));
      providerOptionsPerCall.push(request.providerOptions);
      const system = request.prompt.find((message) => message.role === "system");
      systemPrompts.push(typeof system?.content === "string" ? system.content : "");
      (model as ScriptedModel).calls += 1;
      const chunks = remaining.shift();
      if (chunks === undefined) throw new Error("scripted model exhausted");
      return { stream: simulateReadableStream({ chunks }) };
    },
  }) as unknown as ScriptedModel;
  model.toolNamesPerCall = toolNamesPerCall;
  model.prompts = prompts;
  model.systemPrompts = systemPrompts;
  model.providerOptionsPerCall = providerOptionsPerCall;
  model.calls = 0;
  return model;
}

/** `ResolvedModels` whose every seat is one scripted model. */
export function seats(model: LanguageModel): ResolvedModels<LanguageModel> {
  return { default: model, apps: model, review: model, judge: model };
}

// ─── the harness-runtime doubles, mirrored from `@vendoai/harnesses`
//     (test-doubles.test-util.ts) for the cross-block seam tests that live in
//     THIS package because they need both blocks (the claude-code live box
//     proofs, the render-seam wrapWorkspace slot) ────────────────────────────

export function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

/** No seats at all — for suites where the harness under test is scripted or a
 *  real external loop rather than a seat-reading `vendo()`. */
export function unusedModels(): SeatModels<LanguageModel> {
  return {};
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

export async function readSse(response: Response): Promise<Array<Record<string, unknown>>> {
  const raw = await response.text();
  const blocks = raw.slice(0, -2).split("\n\n");
  return blocks
    .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
    .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);
}
