import { z } from "zod";
import { descriptorHash } from "./descriptor-hash.js";
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
   * WHICH automation this grant is for. Each record is consented to on its own,
   * so a grant minted while arming one never authorizes another and the
   * fire-time lookup matches on this alone — an automation record holds no app
   * reference for `appId` to pair with. Absent on every grant that is not an
   * automation's.
   */
  automationId?: string;
  /**
   * How this grant was minted. `"mcp"` is additive (same mechanism the door
   * wave used for `AuditEvent.kind: "door-auth"`, 01-core §15) and has exactly
   * one mint point: the actions-side projection of the door's OAuth consent
   * (10-mcp §3) — the per-call, honestly-labeled authority handed to `actAs`
   * for venue="mcp" host execution. It is never persisted and never consulted
   * by guard; the other sources are minted from in-product decisions.
   *
   * `"approval"` is the other projection of that kind, and the same three things
   * are true of it: one mint point (the guard's `#grantForExecution`, when an
   * away call runs on a CONSUMED approval), never persisted, never matched. It
   * says what it is — the person's tap on this one call — so a host reading it
   * in `actAs` is told the authority is one allowed call, not a standing yes.
   */
  source: "chat" | "batch" | "automation" | "mcp" | "approval";
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
  automationId: z.string().optional(),
  source: z.enum(["chat", "batch", "automation", "mcp", "approval"]),
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
  /**
   * The standing powers ONE yes to this ask mints — human tool TITLES, never
   * identifiers.
   *
   * Present only on an ask that is a consent moment for work nobody has asked
   * for yet: arming an automation (07 §3), where the yes authorizes calls the
   * agent will make at 2am. That ask parks BEFORE the record exists, so the set
   * is computed at park time and rides here — which is the whole point of
   * putting it on the request rather than in a renderer. Every surface (a text,
   * a card, a console feed) names the same powers because there is one
   * computation, and a surface that has not learned to render them simply shows
   * the ask it always showed.
   *
   * Absent on every ordinary ask, where the call in hand IS the whole of what is
   * being allowed.
   */
  powers?: string[];
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
  powers: z.array(z.string()).optional(),
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

/**
 * The refs projection every `vendo_approvals` row carries, so ref-filtered
 * listings — the guard's pending feed, its abandoned-ask sweep — can see the
 * row on ANY StoreAdapter. One helper because the collection has more than
 * one writer (the guard's park, the automations arming capture): reserved
 * store tables derive these from the row's own columns, but a generic
 * adapter honors exactly what a writer passes, and a writer that skips them
 * mints asks no listing can return and no sweep can expire (field: linkwarden
 * 2026-08-09 — an automation counted pending grants nobody could see or pay).
 */
export function approvalRecordRefs(
  request: ApprovalRequest,
  status: "pending" | "approved" | "denied",
): Record<string, string> {
  return {
    subject: request.ctx.principal.subject,
    status,
    call: request.call.id,
  };
}

/**
 * Everything a mint is told. The subject, the tool, the descriptor hash and the
 * app are read off the approved REQUEST and never off the caller, so a grant is
 * bound to exactly what the person was shown.
 */
export interface MintGrantInput {
  request: ApprovalRequest;
  /** An omitted `scope` is derived: a connector dispatch is granted at the width
   *  of its SLUG — "allow use_service_tool" would be consent to the broker's
   *  whole catalog — and every other tool tool-wide. */
  remember: { duration: GrantDuration; scope?: GrantScope };
  source: PermissionGrant["source"];
  /** WHICH automation this is for; omitted ⇒ not an automation's grant. */
  automationId?: string;
  /** `session`/`task` durations only; omitted ⇒ the request's runId ?? sessionId. */
  contextKey?: string;
}

/**
 * The ONE grant row. The guard's decide path and the automations engine's
 * consent moment both mint through here, so a grant cannot mean two things
 * depending on which of them wrote it.
 */
export function buildGrant(
  { request, remember, source, automationId, contextKey }: MintGrantInput,
  id: GrantId,
  grantedAt: IsoDateTime,
): PermissionGrant {
  const slug = serviceToolSlug(request.call);
  const sessionKey = contextKey ?? request.ctx.sessionId;
  return {
    id,
    subject: request.ctx.principal.subject,
    tool: request.call.tool,
    descriptorHash: descriptorHash(request.descriptor),
    scope: remember.scope ?? (slug === undefined ? { kind: "tool" } : { kind: "service-tool", slug }),
    duration: remember.duration,
    ...(remember.duration === "session"
      ? { contextKey: sessionKey }
      : remember.duration === "task"
        ? { contextKey: request.ctx.trigger?.runId ?? sessionKey }
        : {}),
    ...(request.ctx.appId === undefined ? {} : { appId: request.ctx.appId }),
    ...(automationId === undefined ? {} : { automationId }),
    source,
    grantedAt,
  };
}

/**
 * The refs projection every `vendo_grants` row carries. The same reason
 * {@link approvalRecordRefs} exists: reserved store tables derive these from the
 * row's own columns, but a generic adapter honors exactly what a writer passes
 * — and one that filtered on `app_id` alone would hand back a SIBLING trigger's
 * grant, making the ref-trusting adapter wider than the JS filter above it.
 */
export function grantRefs(grant: PermissionGrant): Record<string, string> {
  return {
    subject: grant.subject,
    tool: grant.tool,
    ...(grant.appId === undefined ? {} : { app_id: grant.appId }),
    ...(grant.automationId === undefined ? {} : { automation_id: grant.automationId }),
  };
}

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
