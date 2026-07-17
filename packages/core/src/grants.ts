import { z } from "zod";
import {
  appIdSchema,
  approvalIdSchema,
  grantIdSchema,
  isoDateTimeSchema,
  type AppId,
  type ApprovalId,
  type GrantId,
  type IsoDateTime,
} from "./ids.js";
import { principalSchema, type Principal } from "./principal.js";
import type { RunContext } from "./run-context.js";
import { triggerRefSchema, type TriggerRef } from "./triggers.js";
import { toolCallSchema, toolDescriptorSchema, type ToolCall, type ToolDescriptor } from "./tools.js";

/** 01-core §5 */
export interface GrantConstraint {
  path: string;
  op: "eq" | "lte" | "gte" | "matches";
  value: string | number | boolean;
}

/** 01-core §5 */
export const grantConstraintSchema = z.object({
  path: z.string(),
  op: z.enum(["eq", "lte", "gte", "matches"]),
  value: z.union([z.string(), z.number(), z.boolean()]),
}).passthrough() satisfies z.ZodType<GrantConstraint>;

/** 01-core §5 */
export type GrantScope =
  | { kind: "tool" }
  | { kind: "exact"; inputHash: string; inputPreview: string }
  | { kind: "constrained"; constraints: GrantConstraint[] };

/** 01-core §5 */
export const grantScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool") }).passthrough(),
  z.object({
    kind: z.literal("exact"),
    inputHash: z.string(),
    inputPreview: z.string(),
  }).passthrough(),
  z.object({
    kind: z.literal("constrained"),
    constraints: z.array(grantConstraintSchema),
  }).passthrough(),
]) satisfies z.ZodType<GrantScope>;

/** 01-core §5 */
export type GrantDuration = "standing" | "session" | "task";

/** 01-core §5 */
export const grantDurationSchema = z.enum(["standing", "session", "task"]) satisfies z.ZodType<GrantDuration>;

/** 01-core §5 */
export interface PermissionGrant {
  id: GrantId;
  subject: string;
  tool: string;
  descriptorHash: string;
  scope: GrantScope;
  duration: GrantDuration;
  contextKey?: string;
  appId?: AppId;
  /**
   * How this grant was minted. `"mcp"` is additive (same mechanism the door
   * wave used for `AuditEvent.kind: "door-auth"`, 01-core §15) and has exactly
   * one mint point: the actions-side projection of the door's OAuth consent
   * (10-mcp §3) — the per-call, honestly-labeled authority handed to `actAs`
   * for venue="mcp" host execution. It is never persisted and never consulted
   * by guard; the other sources are minted from in-product decisions.
   */
  source: "chat" | "batch" | "automation" | "mcp";
  grantedAt: IsoDateTime;
  expiresAt?: IsoDateTime;
  revokedAt?: IsoDateTime;
}

/** 01-core §5 */
export const permissionGrantSchema = z.object({
  id: grantIdSchema,
  subject: z.string(),
  tool: z.string(),
  descriptorHash: z.string(),
  scope: grantScopeSchema,
  duration: grantDurationSchema,
  contextKey: z.string().optional(),
  appId: appIdSchema.optional(),
  source: z.enum(["chat", "batch", "automation", "mcp"]),
  grantedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema.optional(),
  revokedAt: isoDateTimeSchema.optional(),
}).passthrough() satisfies z.ZodType<PermissionGrant>;

/** 01-core §5 */
export interface ApprovalRequest {
  id: ApprovalId;
  call: ToolCall;
  descriptor: ToolDescriptor;
  inputPreview: string;
  invalidatedGrant?: {
    id: GrantId;
    grantedAt: IsoDateTime;
  };
  ctx: {
    principal: Principal;
    venue: RunContext["venue"];
    presence: RunContext["presence"];
    appId?: AppId;
    trigger?: TriggerRef;
  };
  createdAt: IsoDateTime;
}

/** 01-core §5 */
export const approvalRequestSchema = z.object({
  id: approvalIdSchema,
  call: toolCallSchema,
  descriptor: toolDescriptorSchema,
  inputPreview: z.string(),
  invalidatedGrant: z.object({
    id: grantIdSchema,
    grantedAt: isoDateTimeSchema,
  }).passthrough().optional(),
  ctx: z.object({
    principal: principalSchema,
    venue: z.enum(["chat", "app", "automation", "mcp"]),
    presence: z.enum(["present", "away"]),
    appId: appIdSchema.optional(),
    trigger: triggerRefSchema.optional(),
  }).passthrough(),
  createdAt: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<ApprovalRequest>;

/** 01-core §5 */
export interface ApprovalDecision {
  approve: boolean;
  remember?: { scope: GrantScope; duration: GrantDuration };
}

/** 01-core §5 */
export const approvalDecisionSchema = z.object({
  approve: z.boolean(),
  remember: z.object({
    scope: grantScopeSchema,
    duration: grantDurationSchema,
  }).passthrough().optional(),
}).passthrough() satisfies z.ZodType<ApprovalDecision>;
