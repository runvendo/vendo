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
import type { LanguageModel } from "ai";
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

/** Named policy presets: pure sugar that expands to rules before evaluation
 *  (00-overview decision 8). "cautious" asks before write/destructive and
 *  runs read; "readonly" runs read and blocks everything else; "autopilot"
 *  explicitly runs everything — still fully audited, and distinct from
 *  leaving `policy` unset (which reports the "unconfigured" posture). */
export type PolicyPresetName = "cautious" | "readonly" | "autopilot";

export interface PolicyConfigObject {
  file?: string;
  rules?: PolicyRule[];
  directions?: string[];
  code?: PolicyFn;
}

export type PolicyConfig = PolicyPresetName | PolicyConfigObject;

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
  /** The judge's own model, when it has one (vendoAutoJudge exposes the model
   *  it was constructed with). Composition reads this so createVendo can bind
   *  ITS OWN models.judge config onto a vendoModel-built instance — per
   *  createVendo instance, no process-level registry. Custom judges may omit
   *  it; the model is never invoked through this property. */
  model?: LanguageModel;
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

  /** Spec 2026-07-20 (#5): TTL backstop over the general approvals collection —
   *  denies every pending approval older than `ttlMs` (across subjects, via the
   *  idempotent abandon path) so away/automation/stranded approvals self-heal.
   *  Optional: the umbrella feature-detects it. Returns the count swept. */
  sweepExpiredApprovals?(ttlMs: number, at?: number): Promise<number>;

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
  /** cse lane 3 — a source for a cloud-published policy.json body, consulted
   *  by the PolicyResolver STRICTLY AFTER the local file and only when policy
   *  is already configured (opt-in). The umbrella backs it with the hosted
   *  config snapshot; this block never reads the key. Unset = no change. */
  policyCloudFallback?: () => string | undefined;
  /** Build contract §9.10 — the org-admin policy layer, resolved per check from
   *  the caller's asserted orgs (composition reads `/orgs/<orgId>/policy.json`
   *  and unions the rules). Applied as a post-pipeline strictness clamp that can
   *  only TIGHTEN a decision, so host policy always wins; unset = no org layer.
   *  A resolver that throws applies no org rules and is audited — the guard
   *  never guesses at an unreadable policy, and never loosens on one. */
  orgPolicy?: (ctx: RunContext) => Promise<PolicyRule[]>;
  judge?: Judge;
  breakers?: {
    maxCallsPerMinute?: number;
    maxWritesPerRun?: number;
  };
}
