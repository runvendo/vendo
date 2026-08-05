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
import {
  toolCallSchema,
  toolDescriptorSchema,
  USE_SERVICE_TOOL,
  type ToolCall,
  type ToolDescriptor,
} from "./tools.js";

/** 01-core §5, amended 2026-08-03 (connector discovery) — `service-tool` is a
 *  third width between the two the contract froze.
 *
 *  `tool` and `exact` are the two widths a HOST tool has: this whole tool, or
 *  this one payload. The connector dispatcher ({@link USE_SERVICE_TOOL}) has
 *  neither, because its tool name is not its action: `tool` on it would be
 *  consent to a third-party catalog of ~20,000 actions, and `exact` would be a
 *  permission good for one payload and useless on the next run. `service-tool`
 *  is the missing middle — ONE service action, any arguments — which is exactly
 *  the width `tool` has on a host tool, measured at the level a person can
 *  actually consent to. */
export type GrantScope =
  | { kind: "tool" }
  | { kind: "exact"; inputHash: string; inputPreview: string }
  | { kind: "service-tool"; slug: string };

/** 01-core §5 */
export const grantScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool") }).passthrough(),
  z.object({
    kind: z.literal("exact"),
    inputHash: z.string(),
    inputPreview: z.string(),
  }).passthrough(),
  z.object({
    kind: z.literal("service-tool"),
    slug: z.string().min(1),
  }).passthrough(),
]) satisfies z.ZodType<GrantScope>;

/** The service action a call names, or undefined for every call that is not a
 *  connector dispatch. The one place the dispatcher's argument shape is read as
 *  authority, so the grant law, the arm-time capture, and the mint cannot
 *  disagree about what was consented to. */
export function serviceToolSlug(call: Pick<ToolCall, "tool" | "args">): string | undefined {
  if (call.tool !== USE_SERVICE_TOOL) return undefined;
  const slug = (call.args as { slug?: unknown } | undefined)?.slug;
  return typeof slug === "string" && slug.length > 0 ? slug : undefined;
}

/** A service action in a person's words — `GMAIL_SEND_EMAIL` → "send email in
 *  Gmail" — for the consent sentence, which may never print a raw identifier at
 *  someone (design §3's voice law).
 *
 *  DISPLAY ONLY. Nothing about authority or risk is ever read out of a name
 *  (#747 deleted the word lists on purpose) — the grade comes from the broker's
 *  own per-tool tag through the risk resolver. Chrome holds the brand table
 *  ("googlecalendar" → "Google Calendar") and renders the richer label beside a
 *  logo; this is the plain sentence the engine can write with no UI on hand. */
export function serviceToolPhrase(slug: string): string {
  const words = slug.split(/[_\s]+/u).filter(Boolean).map((word) => word.toLowerCase());
  const service = words[0];
  if (service === undefined) return slug;
  if (words.length === 1) return service;
  return `${words.slice(1).join(" ")} in ${service.charAt(0).toUpperCase()}${service.slice(1)}`;
}

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
   * WHICH trigger of that app this grant is for. An automation is an app with a
   * list of triggers, and each one is consented to on its own: a grant minted
   * while arming one trigger never authorizes another, so the fire-time lookup
   * matches on it alongside `appId`. Absent on grants minted before an app had
   * more than one trigger, and on every grant that is not an automation's.
   */
  triggerId?: string;
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
  triggerId: z.string().optional(),
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
    /** The conversation that parked it (`RunContext.sessionId`) — the identity
     *  approval delivery is scoped by. Optional only because rows persisted
     *  before it existed can't carry it; every new park writes it, and
     *  scoped consumers fail closed on its absence. */
    sessionId?: string;
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
    sessionId: z.string().optional(),
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
