import { z } from "zod";
import { permissionGrantSchema, type PermissionGrant } from "./grants.js";
import { appIdSchema, type AppId } from "./ids.js";
import { principalSchema, type Principal } from "./principal.js";
import { triggerRefSchema, type TriggerRef } from "./triggers.js";

export type { TriggerRef } from "./triggers.js";

/** CORE-2 (wave 5 — 01 §3 amendment parked): the MCP door's OAuth-consent
 *  projection (10-mcp §3), attached by the door on venue="mcp" calls. */
export interface McpConsent {
  clientId: string;
  scopes: string[];
}

/** CORE-2 */
export const mcpConsentSchema = z.object({
  clientId: z.string(),
  scopes: z.array(z.string()),
}).passthrough() satisfies z.ZodType<McpConsent>;

/** 01-core §3. `actor` (block-actions design §C) is a generic audit-enrichment
    field: the human principal behind a request made under a different
    `principal`, for whenever `principal` and the acting human diverge. Its
    original motivating case — the wire re-contextualizing a member's request
    onto an org-owned row (`principal` becomes the org, `actor` stays the
    signed-in member) — was cut with the org storage layer (kill-list §A5);
    the field itself stays, since it's a generic shape, not org-specific
    machinery.
    CORE-2 (wave 5): `grant` and `mcpConsent` are promoted to first-class
    optional fields — the guard attaches the exact grant behind an away
    execution, the MCP door attaches its consent projection — replacing the
    structural twins downstream blocks used to declare. */
export interface RunContext {
  principal: Principal;
  venue: "chat" | "app" | "automation" | "mcp";
  presence: "present" | "away";
  sessionId: string;
  appId?: AppId;
  trigger?: TriggerRef;
  requestHeaders?: Record<string, string>;
  actor?: Principal;
  grant?: PermissionGrant;
  mcpConsent?: McpConsent;
}

/** 01-core §3 */
export const runContextSchema = z.object({
  principal: principalSchema,
  venue: z.enum(["chat", "app", "automation", "mcp"]),
  presence: z.enum(["present", "away"]),
  sessionId: z.string(),
  appId: appIdSchema.optional(),
  trigger: triggerRefSchema.optional(),
  requestHeaders: z.record(z.string()).optional(),
  actor: principalSchema.optional(),
  grant: permissionGrantSchema.optional(),
  mcpConsent: mcpConsentSchema.optional(),
}).passthrough() satisfies z.ZodType<RunContext>;
