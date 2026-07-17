import { VENDO_POLICY_FORMAT } from "@vendoai/core";
import type {
  AppId,
  ApprovalDecision,
  ApprovalId,
  ApprovalRequest,
  AuditEvent,
  GrantId,
  Guard,
  GuardDecision,
  IsoDateTime,
  PermissionGrant,
  Principal,
  RiskLabel,
  RunContext,
  StoreAdapter,
  ToolCall,
  ToolDescriptor,
  ToolRegistry,
} from "@vendoai/core";
import { z } from "zod";

export interface PolicyRule {
  match: {
    tool?: string;
    risk?: RiskLabel;
    venue?: RunContext["venue"];
    presence?: RunContext["presence"];
  };
  action: "run" | "ask" | "block";
  note?: string;
}

export type PolicyFn = (
  call: ToolCall,
  descriptor: ToolDescriptor,
  ctx: RunContext,
) => GuardDecision | undefined;

/** Additive composition hook: resolve a call's effective risk before policy
 * rules, grants, breakers, and approvals evaluate it. Throwing, returning an
 * unknown value, or returning undefined preserves the descriptor's risk. */
export type RiskResolver = (
  call: ToolCall,
  descriptor: ToolDescriptor,
  ctx: RunContext,
) => RiskLabel | undefined | Promise<RiskLabel | undefined>;

export type PolicyConfig = {
  file?: string;
  rules?: PolicyRule[];
  directions?: string[];
  code?: PolicyFn;
};

export interface PolicyFile {
  format: typeof VENDO_POLICY_FORMAT;
  directions?: string[];
  rules?: PolicyRule[];
}

export const policyRuleSchema = z
  .object({
    match: z
      .object({
        tool: z.string().optional(),
        risk: z.enum(["read", "write", "destructive"]).optional(),
        venue: z.enum(["chat", "app", "automation", "mcp"]).optional(),
        presence: z.enum(["present", "away"]).optional(),
      })
      .strict(),
    action: z.enum(["run", "ask", "block"]),
    note: z.string().optional(),
  })
  .strict() satisfies z.ZodType<PolicyRule>;

export const policyFileSchema = z
  .object({
    format: z.literal(VENDO_POLICY_FORMAT),
    directions: z.array(z.string()).optional(),
    rules: z.array(policyRuleSchema).optional(),
  })
  .strict() satisfies z.ZodType<PolicyFile>;

export interface Judge {
  decide(input: {
    call: ToolCall;
    descriptor: ToolDescriptor;
    ctx: RunContext;
    recent: AuditEvent[];
    directions: string[];
  }): Promise<{ action: "run" | "ask" | "block"; rationale: string }>;
}

export interface VendoGuard extends Guard {
  bind(tools: ToolRegistry): ToolRegistry;

  approvals: {
    pending(principal: Principal): Promise<ApprovalRequest[]>;
    decide(
      ids: ApprovalId | ApprovalId[],
      decision: ApprovalDecision,
      principal: Principal,
    ): Promise<void>;
  };

  grants: {
    list(principal: Principal): Promise<PermissionGrant[]>;
    revoke(id: GrantId, principal: Principal): Promise<void>;
  };

  audit: {
    query(filter: {
      principal?: Principal;
      appId?: AppId;
      kind?: AuditEvent["kind"];
      from?: IsoDateTime;
      to?: IsoDateTime;
      cursor?: string;
      limit?: number;
    }): Promise<{ events: AuditEvent[]; cursor?: string }>;
    export(filter?: {
      from?: IsoDateTime;
      to?: IsoDateTime;
    }): AsyncIterable<string>;
  };

  status(): {
    posture: "unconfigured" | "rules" | "judge" | "rules+judge";
  };
}

export interface CreateGuardConfig {
  store: StoreAdapter;
  resolveRisk?: RiskResolver;
  policy?: PolicyConfig;
  judge?: Judge;
  breakers?: {
    maxCallsPerMinute?: number;
    maxWritesPerRun?: number;
  };
}
