import { z } from "zod";
import { appIdSchema, isoDateTimeSchema, turnIdSchema, type AppId, type IsoDateTime, type Json, type TurnId } from "./ids.js";
import { principalSchema, type Principal } from "./principal.js";
import type { RunContext } from "./run-context.js";
import { triggerRefSchema, type TriggerRef } from "./triggers.js";
import type { GuardDecision } from "./guard.js";
import { riskLabelSchema, type RiskLabel, type ToolOutcome } from "./tools.js";

/** 01-core §7 */
export interface AuditEvent {
  id: string;
  at: IsoDateTime;
  kind: "tool-call" | "approval" | "policy-decision" | "run" | "app-lifecycle" | "share" | "door-auth" | "principal";
  principal: Principal;
  venue: RunContext["venue"];
  presence: RunContext["presence"];
  appId?: AppId;
  trigger?: TriggerRef;
  /** The turn this row came out of, so a turn's rows join to each other, to its
   *  mirrored calls and to the views it painted. Copied from the `RunContext` by
   *  the mint helpers — never authored by a caller. Absent on a run with no turn
   *  (a webhook, a schedule fire, an org-policy load). */
  turnId?: TurnId;
  /** The MCP client this row came in on — `mcpc_*` or a CIMD URL for a
   *  third-party agent, `svc:<keyId>` for a host's own service key. Absent on
   *  every row that did not arrive at the door. */
  clientId?: string;
  tool?: string;
  /** The risk the guard actually gated on — the EFFECTIVE grade, after any
   *  `resolveRisk`, not the descriptor's static label. Absent on rows written
   *  with no tool descriptor in hand, and on a control/frozen row: the freeze
   *  short-circuit runs before risk resolution, so it has no effective grade to
   *  report and omits the field rather than chip the declared label. */
  risk?: RiskLabel;
  inputPreview?: string;
  outcome?: ToolOutcome["status"];
  decidedBy?: GuardDecision["decidedBy"];
  detail?: Json;
}

/**
 * The ctx half of an audit row — the fields every row copies off the run it came
 * out of.
 *
 * ONE copy, because eight hand-written ones is exactly how `turnId` reached three
 * of them and silently missed five: the guard's own mint got it, and the
 * connect gate, the share row, the MCP door's tool-call row and the away-run
 * summary each kept spreading five fields by hand and were never told about the
 * sixth. A row that cannot be joined to its turn is not a smaller row, it is an
 * unanswerable question in the plane billing and reconciliation read.
 *
 * Absent optionals stay ABSENT rather than becoming `undefined` keys, so a row
 * built through this is byte-identical to the hand-written ones it replaces.
 */
export const auditContext = (
  ctx: Pick<RunContext, "principal" | "venue" | "presence" | "appId" | "trigger" | "turnId" | "mcpConsent">,
): Pick<AuditEvent, "principal" | "venue" | "presence" | "appId" | "trigger" | "turnId" | "clientId"> => ({
  principal: ctx.principal,
  venue: ctx.venue,
  presence: ctx.presence,
  ...(ctx.appId === undefined ? {} : { appId: ctx.appId }),
  ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
  ...(ctx.turnId === undefined ? {} : { turnId: ctx.turnId }),
  ...(ctx.mcpConsent === undefined ? {} : { clientId: ctx.mcpConsent.clientId }),
});

/** 01-core §7 */
export const auditEventSchema = z.object({
  id: z.string().regex(/^aud_.+$/),
  at: isoDateTimeSchema,
  kind: z.enum(["tool-call", "approval", "policy-decision", "run", "app-lifecycle", "share", "door-auth", "principal"]),
  principal: principalSchema,
  venue: z.enum(["chat", "app", "automation", "mcp"]),
  presence: z.enum(["present", "away"]),
  appId: appIdSchema.optional(),
  trigger: triggerRefSchema.optional(),
  turnId: turnIdSchema.optional(),
  clientId: z.string().optional(),
  tool: z.string().optional(),
  risk: riskLabelSchema.optional(),
  inputPreview: z.string().optional(),
  outcome: z.enum(["ok", "error", "pending-approval", "blocked", "connect-required"]).optional(),
  decidedBy: z.enum(["grant", "rule", "judge", "default", "confirmEach", "breaker", "denied", "org", "frozen"]).optional(),
  detail: z.unknown().optional(),
}).passthrough() satisfies z.ZodType<AuditEvent>;
