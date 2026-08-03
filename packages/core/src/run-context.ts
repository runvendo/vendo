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

/** The doors a run can arrive through. ONE list: the type, the schema, and the
 *  security tests that sweep every venue all derive from it, so a fifth venue
 *  cannot be added in one place and silently escape the others. THE LAW's
 *  predicate is presence, never the venue (grant-sets `isUnattended`) — the
 *  sweeps exist to keep it that way for venues nobody has thought of yet. */
export const VENUES = ["chat", "app", "automation", "mcp"] as const;
export type Venue = (typeof VENUES)[number];

/** CORE-2 */
const mcpConsentSchema = z.object({
  clientId: z.string(),
  scopes: z.array(z.string()),
}).passthrough() satisfies z.ZodType<McpConsent>;

/** Build contract §9.1 — one org the caller belongs to, ASSERTED by the host's
    own identity system per request/run (the `memberships` auth-preset seam),
    never a Vendo row. `org` is the host-issued id VERBATIM: it becomes the
    workspace owner for `/orgs/<org>/**` and the row subject of an org-owned
    app, so it must be stable in the host's tables. `admin: true` makes the
    member an implicit owner of every app the org holds. */
export interface Membership {
  org: string;
  /** Consumer-voice org name (what the Share dialog shows). */
  display?: string;
  /** Host-issued team ids within this org (grant principal `team:<org>/<id>`). */
  teams?: string[];
  admin?: boolean;
}

/** Build contract §9.1 */
export const membershipSchema = z.object({
  org: z.string().min(1),
  display: z.string().optional(),
  teams: z.array(z.string()).optional(),
  admin: z.boolean().optional(),
}).passthrough() satisfies z.ZodType<Membership>;

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
  venue: Venue;
  presence: "present" | "away";
  sessionId: string;
  appId?: AppId;
  trigger?: TriggerRef;
  requestHeaders?: Record<string, string>;
  actor?: Principal;
  grant?: PermissionGrant;
  mcpConsent?: McpConsent;
  /** Build contract §9.1 — the orgs/teams the host asserted for this principal.
      Absent ⇒ nothing asserted ⇒ `can()` degenerates to ownership. */
  memberships?: Membership[];
}

/** 01-core §3 */
export const runContextSchema = z.object({
  principal: principalSchema,
  venue: z.enum(VENUES),
  presence: z.enum(["present", "away"]),
  sessionId: z.string(),
  appId: appIdSchema.optional(),
  trigger: triggerRefSchema.optional(),
  requestHeaders: z.record(z.string()).optional(),
  actor: principalSchema.optional(),
  grant: permissionGrantSchema.optional(),
  mcpConsent: mcpConsentSchema.optional(),
  memberships: z.array(membershipSchema).optional(),
}).passthrough() satisfies z.ZodType<RunContext>;
