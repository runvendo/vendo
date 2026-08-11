/**
 * The doubles the render-seam and validate-gate suites arrived with when they
 * moved home from `@vendoai/harnesses` (the seam lives here now).
 *
 * A copy, deliberately: `@vendoai/harnesses` keeps its own equivalent
 * (`test-doubles.test-util.ts`) and the umbrella keeps another
 * (`agent-doubles.test-util.ts`) rather than any package publishing a
 * test-only subpath — a doubles surface on a published package is surface
 * nobody asked for. The `testing/` fixtures beside `src` are a different
 * vocabulary (store-backed, scripted-response models); these tests were
 * written against the harness doubles and move verbatim.
 */
import type {
  ApprovalId,
  ApprovalRequest,
  AuditEvent,
  CommitResult,
  Guard,
  GuardDecision,
  RunContext,
  WorkspaceFs,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
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
   *  rows; here it is stated, so a suite can pin the per-file behaviour without
   *  a store. */
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

export type ScriptedModel = LanguageModel & {
  toolNamesPerCall: string[][];
  /** What each call actually SENT — the only place a suite can prove what the
   *  loop's history assembly did or did not include. */
  prompts: unknown[];
  /** The system message of each call, so a suite can assert on the BRIEF a loop
   *  assembled without reaching into the loop to get it. */
  systemPrompts: string[];
  calls: number;
};

/** A model that replays scripted provider chunks — so the caller's loop, not a
 *  real model, is what the suite measures. */
export function scriptedModel(turns: StreamPart[][]): ScriptedModel {
  const remaining = turns.map((turn) => [...turn]);
  const toolNamesPerCall: string[][] = [];
  const prompts: unknown[] = [];
  const systemPrompts: string[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      toolNamesPerCall.push((request.tools ?? []).map((tool) => tool.name));
      prompts.push(structuredClone(request.prompt));
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
  model.calls = 0;
  return model;
}
