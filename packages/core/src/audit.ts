import { z } from "zod";
import { appIdSchema, isoDateTimeSchema, turnIdSchema, type AppId, type IsoDateTime, type Json, type TurnId } from "./ids.js";
import { principalSchema, type Principal } from "./principal.js";
import type { RunContext } from "./run-context.js";
import { triggerRefSchema, type TriggerRef } from "./triggers.js";
import type { GuardDecision } from "./guard.js";
import type { ToolOutcome } from "./tools.js";

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
  tool?: string;
  inputPreview?: string;
  outcome?: ToolOutcome["status"];
  decidedBy?: GuardDecision["decidedBy"];
  detail?: Json;
}

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
  tool: z.string().optional(),
  inputPreview: z.string().optional(),
  outcome: z.enum(["ok", "error", "pending-approval", "blocked", "connect-required"]).optional(),
  decidedBy: z.enum(["grant", "rule", "judge", "default", "confirmEach", "breaker", "denied", "org"]).optional(),
  detail: z.unknown().optional(),
}).passthrough() satisfies z.ZodType<AuditEvent>;
