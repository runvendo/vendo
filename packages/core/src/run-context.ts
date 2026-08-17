import { z } from "zod";
import type { UIMessage } from "ai";
import { permissionGrantSchema, type PermissionGrant } from "./grants.js";
import { appIdSchema, turnIdSchema, type AppId, type Json, type TurnId } from "./ids.js";
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

/** The text channel's proof that this subject authorized this phone: a code
    minted inside the product while they were signed in as that subject, then
    sent back FROM the phone. Carried on the ctx like `mcpConsent`, and for the
    same reason — a texted turn has no browser session, so its host calls have
    nothing to forward and must authenticate through the ActAs seam instead. */
export interface ChannelLink {
  channel: "text";
  linkedAt: string;
}

const channelLinkSchema = z.object({
  channel: z.literal("text"),
  linkedAt: z.string(),
}).passthrough() satisfies z.ZodType<ChannelLink>;

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
  /** Consumer-voice org name, so a surface names the org instead of its id. */
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
  /** Present ⇒ this run reached us over the text channel, from a linked phone. */
  channelLink?: ChannelLink;
  /** The per-slug service actions THIS firing already holds a live grant for.
   *
   *  Resolved per run by whoever fires it (the automations engine reads the
   *  (app, trigger)'s own grants), never stored on the ctx by a caller who could
   *  widen it: it is read by §12's projection to decide whether the connector
   *  dispatcher is on this run's listing at all. Absent ⇒ none ⇒ the dispatcher
   *  is withheld, so it fails closed. It does not authorize anything — the guard
   *  still decides every call — it only says which door is worth showing. */
  grantedServiceSlugs?: readonly string[];
  /** Build contract §9.1 — the orgs/teams the host asserted for this principal.
      Absent ⇒ nothing asserted ⇒ `can()` degenerates to ownership. */
  memberships?: Membership[];
  /** Agents spec (2026-08-04): the host's asserted profile of the present user
      (name, plan, role, …). Server-trust and MODEL-VISIBLE — prompt assembly's
      `[User]` block reads it — so data only, never functions or secrets. */
  user?: Record<string, Json>;
  /** The named shared meters this request's usage also counts into, pool name →
      the id it accrues to. Host-asserted (the auth preset's pools seam) and read
      by the limits policy; never rendered to the model. */
  pools?: Record<string, string>;
  /** Agents spec (2026-08-04): the host's own bag for guards and tools, never
      the model. Functions are allowed and callable at check time; only plain
      data survives into anything persisted (the frozen approval snapshot is an
      explicit projection — `ApprovalRequest["ctx"]` — so nothing here rides
      into it unless that projection names it). */
  context?: Record<string, unknown>;
  /** Agents spec (2026-08-04): the turn's canonical transcript, for guards and
      judges that weigh a call against what the user actually asked. An accessor,
      not a copy — attached by whoever resolves the thread (the harness runtime),
      absent on a ctx built before any thread exists. In-process only; it never
      serializes. */
  messages?: () => readonly UIMessage[];
  /**
   * The turn this run belongs to. Carried HERE rather than passed beside the ctx
   * because the ctx is what already reaches every audit mint, every guarded
   * call, and every view emission — one field on the value everyone holds beats
   * a new parameter on fifteen signatures.
   *
   * Optional because a run can predate a turn: a webhook, a schedule fire, an
   * org-policy load. Absent means "no turn", never "unknown turn".
   */
  turnId?: TurnId;
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
  channelLink: channelLinkSchema.optional(),
  grantedServiceSlugs: z.array(z.string()).optional(),
  memberships: z.array(membershipSchema).optional(),
  user: z.record(z.unknown()).optional(),
  pools: z.record(z.string()).optional(),
  context: z.record(z.unknown()).optional(),
  // `messages` is deliberately not named here: it is function-valued and
  // in-process only, so no wire shape exists for it (`.passthrough()` keeps it
  // on a ctx that already carries one).
  turnId: turnIdSchema.optional(),
}).passthrough() satisfies z.ZodType<RunContext>;
