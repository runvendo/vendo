import {
  descriptorHash,
  type ApprovalId,
  type ApprovalRequest,
  type AuditEvent,
  type Guard,
  type GuardDecision,
  type PermissionGrant,
  type RunContext,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";

export type ProgrammedAction = "run" | "ask" | "block";

export interface GuardFixtureOptions {
  rules?: Record<string, ProgrammedAction>;
  grants?: PermissionGrant[];
  now?: () => Date;
}

export interface GuardFixture extends Guard {
  readonly rules: Map<string, ProgrammedAction>;
  readonly grants: PermissionGrant[];
  readonly approvals: ApprovalRequest[];
  readonly audit: AuditEvent[];
  decide(id: ApprovalId, approved: boolean): void;
}

const inputPreview = (args: unknown): string => {
  try {
    return JSON.stringify(args) ?? "null";
  } catch {
    return "[unserializable input]";
  }
};

const grantMatches = (
  grant: PermissionGrant,
  descriptor: ToolDescriptor,
  ctx: RunContext,
  now: Date,
): boolean => {
  if (grant.subject !== ctx.principal.subject || grant.tool !== descriptor.name) return false;
  if (grant.descriptorHash !== descriptorHash(descriptor) || grant.scope.kind !== "tool") return false;
  if (grant.revokedAt !== undefined || (grant.expiresAt !== undefined && grant.expiresAt <= now.toISOString())) return false;
  if (grant.appId !== undefined && grant.appId !== ctx.appId) return false;
  if ((grant.duration === "session" || grant.duration === "task") && grant.contextKey !== ctx.sessionId) return false;
  return true;
};

/** Create a deterministic Guard fixture with inspectable rules, approvals, grants, and audit. */
export const guardFixture = (options: GuardFixtureOptions = {}): GuardFixture => {
  const rules = new Map(Object.entries(options.rules ?? {}));
  const grants = [...(options.grants ?? [])];
  const approvals: ApprovalRequest[] = [];
  const audit: AuditEvent[] = [];
  const callbacks = new Set<(id: ApprovalId, approved: boolean) => void>();
  const now = options.now ?? (() => new Date());
  let nextApproval = 1;

  const approvalFor = (
    call: ToolCall,
    descriptor: ToolDescriptor,
    ctx: RunContext,
  ): ApprovalRequest => ({
    id: `apr_fixture_${nextApproval++}`,
    call: structuredClone(call),
    descriptor: structuredClone(descriptor),
    inputPreview: inputPreview(call.args),
    ctx: {
      principal: { ...ctx.principal },
      venue: ctx.venue,
      presence: ctx.presence,
      appId: ctx.appId,
      trigger: ctx.trigger === undefined ? undefined : { ...ctx.trigger },
    },
    createdAt: now().toISOString(),
  });

  return {
    rules,
    grants,
    approvals,
    audit,
    async check(call, descriptor, ctx): Promise<GuardDecision> {
      if (descriptor.critical === true) {
        const approval = approvalFor(call, descriptor, ctx);
        approvals.push(approval);
        return { action: "ask", approval, decidedBy: "critical" };
      }

      const grant = grants.find((candidate) => grantMatches(candidate, descriptor, ctx, now()));
      if (grant !== undefined) return { action: "run", decidedBy: "grant", grantId: grant.id };

      const programmed = rules.get(descriptor.name);
      if (programmed === "block") {
        return { action: "block", reason: `Programmed block for ${descriptor.name}`, decidedBy: "rule" };
      }
      if (programmed === "ask") {
        const approval = approvalFor(call, descriptor, ctx);
        approvals.push(approval);
        return { action: "ask", approval, decidedBy: "rule" };
      }
      if (programmed === "run") return { action: "run", decidedBy: "rule" };
      return { action: "run", decidedBy: "default" };
    },
    async report(event): Promise<void> {
      audit.push(structuredClone(event));
    },
    async directions(): Promise<string[]> {
      return [];
    },
    onApprovalDecision(callback): () => void {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    decide(id, approved): void {
      const index = approvals.findIndex((approval) => approval.id === id);
      if (index === -1) throw new Error(`Unknown fixture approval: ${id}`);
      approvals.splice(index, 1);
      for (const callback of callbacks) callback(id, approved);
    },
  };
};

/** Bind a registry through decide → park/execute → report, matching 05-guard §2. */
export const bindTools = (guard: Guard, registry: ToolRegistry): ToolRegistry => {
  let nextAudit = 1;

  return {
    descriptors: () => registry.descriptors(),
    async execute(call, ctx): Promise<ToolOutcome> {
      const descriptors = await registry.descriptors();
      const descriptor = descriptors.find((candidate) => candidate.name === call.tool);
      if (descriptor === undefined) {
        return { status: "error", error: { code: "not-found", message: `Unknown tool: ${call.tool}` } };
      }

      const decision = await guard.check(call, descriptor, ctx);
      let outcome: ToolOutcome;
      if (decision.action === "run") {
        outcome = await registry.execute(call, ctx);
      } else if (decision.action === "ask") {
        outcome = { status: "pending-approval", approvalId: decision.approval.id };
      } else {
        outcome = { status: "blocked", reason: decision.reason };
      }

      await guard.report({
        id: `aud_fixture_${nextAudit++}`,
        at: new Date().toISOString(),
        kind: "tool-call",
        principal: { ...ctx.principal },
        venue: ctx.venue,
        presence: ctx.presence,
        appId: ctx.appId,
        trigger: ctx.trigger === undefined ? undefined : { ...ctx.trigger },
        tool: descriptor.name,
        inputPreview: inputPreview(call.args),
        outcome: outcome.status,
        decidedBy: decision.decidedBy,
        detail: { callId: call.id },
      });
      return outcome;
    },
  };
};
