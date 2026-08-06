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
  Guard,
  GuardDecision,
  Json,
  RunContext,
  ToolCall,
  ToolDescriptor,
  ToolOutcome,
  ToolRegistry,
} from "@vendoai/core";
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
  policy: Record<string, "run" | "ask" | "block">,
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
