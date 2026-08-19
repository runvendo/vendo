import {
  type AppId,
  type ApprovalDecision,
  type ApprovalId,
  type ApprovalRequest,
  type AuditEvent,
  type GrantId,
  type Guard,
  type GuardDecision,
  type IsoDateTime,
  type PermissionGrant,
  type Principal,
  type RecordInput,
  type RiskLabel,
  riskLabelSchema,
  type RiskResolver,
  type RunContext,
  type StoreAdapter,
  type StoreOps,
  type ToolCall,
  type ToolDescriptor,
  type ToolRegistry,
  VENDO_POLICY_FORMAT,
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

/** Re-exported: the hook is defined in core because the automations engine
 * grades an arm-time declaration with the same resolver the guard runs. */
export type { RiskResolver };

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
        risk: riskLabelSchema.optional(),
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

  /** `report` with the audit row handed to `place` instead of written to the
   *  guard's own engine — the seam a batched turn folds its ONE run row
   *  through, so the row rides the same call as the messages it describes.
   *  Scope is that row: a per-tool-call decision has no batch to ride and
   *  keeps writing one row per call.
   *
   *  Optional and FEATURE-DETECTED, exactly as `previewCheck` is: a guard that
   *  omits it leaves the caller writing the row through `report`, which is
   *  where every caller started. */
  reportThrough?(
    event: AuditEvent,
    place: (collection: string, record: RecordInput) => Promise<unknown>,
  ): Promise<void>;

  /** The park-side mirror of `onApprovalDecision`: fires when a check parks an
   *  approval, with the persisted request. Optional on core's Guard (existing
   *  implementations predate it); always present here. */
  onApprovalRequested(cb: (request: ApprovalRequest) => void): () => void;

  approvals: {
    /** The resolved parked-approval TTL, in ms (`0` disables expiry). The
     *  guard holds it because it is the guard's own lifecycle number — both
     *  sweeps that read it (`sweepExpiredApprovals` here, and the umbrella's
     *  BYO parked-call sweep) are sweeping approvals this guard minted — so a
     *  host that passes a built instance keeps the knob instead of losing it
     *  with the rules that came in beside it. */
    parkedCallTtlMs: number;
    pending(principal: Principal): Promise<ApprovalRequest[]>;
    /** ONE approval, whatever became of it — the read `pending` stops serving
     *  the moment a row is decided. It exists so a caller that answered an ask
     *  can still say WHAT it answered (`turns.resume` tells "this turn was
     *  already resumed" from "no such turn" with it) instead of reaching into
     *  the guard's own collection. Owner-scoped exactly as `pending` is: an
     *  unknown or foreign id reads back as absent, never as forbidden.
     *  Optional for the reason `sweepExpiredApprovals` is — `VendoGuard` is a
     *  published interface and an implementation written before this method
     *  must keep compiling; every guard this package builds has it. */
    get?(
      id: ApprovalId,
      principal: Principal,
    ): Promise<{ request: ApprovalRequest; status: "pending" | "approved" | "denied" } | undefined>;
    decide(
      ids: ApprovalId | ApprovalId[],
      decision: ApprovalDecision,
      principal: Principal,
    ): Promise<void>;
    /** "I take that back" — the mirror of `grants.revoke` for a DECIDED
     *  approval. A revoked denial stops answering its call (the next issue
     *  asks again); a revoked, unconsumed approval can no longer replay.
     *  Owner-scoped; a pending approval conflicts (deny it instead). */
    revoke(id: ApprovalId, principal: Principal): Promise<void>;
  };

  /** TTL backstop over the general approvals collection —
   *  denies every pending approval older than `ttlMs` (across subjects, via the
   *  idempotent abandon path) so away/automation/stranded approvals self-heal.
   *  Optional: the umbrella feature-detects it. Returns the count swept. */
  sweepExpiredApprovals?(ttlMs: number, at?: number): Promise<number>;

  /** The emergency stop, read first on every check: while it is set every call
   *  is blocked, declared reads and calls a standing grant would authorize
   *  included. `by` names who flipped it and lands on the audit trail. */
  freeze(by: string): Promise<void>;
  unfreeze(by: string): Promise<void>;
  frozen(): Promise<boolean>;

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

/**
 * The host's RULES for a guard — everything a deployment decides, with none of
 * the plumbing (the store, the risk resolver, the org-policy reader) that only
 * a composition can supply. This is what {@link guard} carries and what
 * `createVendo({ guard })` / `agent({ guard })` accept beside a built
 * {@link VendoGuard}: the spec form is completed by whoever composes it,
 * through `createGuard` — the one constructor — and an instance always wins
 * verbatim.
 */
export interface GuardRules {
  policy?: PolicyConfig;
  judge?: Judge;
  /** Approval lifecycle. `parkedCallTtlMs` is the idle timeout for a pending
   *  approval — a guarded call parked from a BYO agent loop (a
   *  `vendo/approval-ref@1` envelope with no thread to resume through), and the
   *  general TTL backstop over stranded away/automation approvals. Past it the
   *  sweep denies through the existing abandonment semantics and
   *  `<VendoApprovalEmbed>` reads "expired". Default 60 min; `0` disables
   *  expiry. Vendo-thread approvals are untouched — their abandonment stays
   *  turn-driven. */
  approvals?: {
    parkedCallTtlMs?: number;
  };
  /** 05 §2's deterministic breakers — the rate limits under everything else. Past
   *  either one a would-be `run` becomes an `ask` until the window clears:
   *  `maxCallsPerMinute` counts every call by one principal (default 60),
   *  `maxWritesPerRun` counts the `write` and `destructive` calls of one run
   *  (default 20). A deployment decision like the rules above, so a host sets them
   *  through `guard({ breakers })`; unset leaves the defaults. Each is a
   *  non-negative integer, refused at construction otherwise; `0` is the lockdown
   *  — every call asks. */
  breakers?: {
    maxCallsPerMinute?: number;
    maxWritesPerRun?: number;
  };
}

export interface CreateGuardConfig extends GuardRules {
  store: StoreAdapter;
  /** The 42-op surface over that SAME store, when the composition could resolve
   *  one (`selectStoreOps` answers `undefined` for a store with neither its own
   *  ops nor a SQL handle). Every drawer this block owns — approvals, grants,
   *  audit, the effect ledger, the freeze switch, the transition receipts —
   *  goes through `ops.engine.*`, so the allowlist gate applies to all of them.
   *  Unset, the same seven verbs are served straight off the adapter's own
   *  record doors, which is what a host's BYO `StoreAdapter` gets. */
  ops?: StoreOps;
  resolveRisk?: RiskResolver;
  /**
   * The standing powers one yes to a parked ask would mint, for
   * `ApprovalRequest.powers`.
   *
   * Composition supplies it because the guard cannot know: arming an automation
   * is the one ask whose yes authorizes calls NOBODY HAS MADE YET, and which
   * tools those are is a question only the automations engine can answer. Asked
   * once per park, for every ask — an implementation that has nothing to say
   * about this call answers `undefined` and the request carries no `powers`.
   *
   * A throw or a rejection is swallowed: an ask that a person needs to see must
   * never fail to park because a label could not be computed.
   */
  describePowers?: (call: ToolCall, ctx: RunContext) => Promise<readonly string[] | undefined>;
  /** Build contract §9.10 — the org-admin policy layer, resolved per check from
   *  the caller's asserted orgs (composition reads `/orgs/<orgId>/policy.json`
   *  and unions the rules). Applied as a post-pipeline strictness clamp that can
   *  only TIGHTEN a decision, so host policy always wins; unset = no org layer.
   *  A resolver that throws applies no org rules and is audited — the guard
   *  never guesses at an unreadable policy, and never loosens on one. */
  orgPolicy?: (ctx: RunContext) => Promise<PolicyRule[]>;
}
