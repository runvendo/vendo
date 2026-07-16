import { z } from "zod";

/** 01-core §2 (block-actions design §C: `kind:"org"` principals are real —
    an org principal owns rows exactly like a user principal does; members act
    through it per the org-membership roles in @vendoai/store). */
export interface Principal {
  kind: "user" | "org";
  subject: string;
  display?: string;
  ephemeral?: boolean;
}

/** 01-core §2 */
export const principalSchema = z.object({
  kind: z.enum(["user", "org"]),
  subject: z.string(),
  display: z.string().optional(),
  ephemeral: z.boolean().optional(),
}).passthrough() satisfies z.ZodType<Principal>;

/** Block-actions design §C — the runtime-owned subject namespace. Subjects the
    runtime mints for itself (webhook trigger principals, org principals) live
    under `vendo:` so they can never collide with a host-resolved subject: host
    principal resolvers are FORBIDDEN from producing reserved subjects (the wire
    rejects them loudly, 09 §2), and reserved subjects can never hold connected
    accounts (04 §3). */
export const RESERVED_SUBJECT_PREFIX = "vendo:";

export function isReservedSubject(subject: string): boolean {
  return subject.startsWith(RESERVED_SUBJECT_PREFIX);
}

/** Webhook trigger principals: `vendo:webhook:<source>`. The pre-namespace
    `webhook:<source>` form is retired — nothing durable was ever keyed by it
    (it only ever appeared on audit events for rejected deliveries). */
export function webhookSubject(source: string): string {
  return `${RESERVED_SUBJECT_PREFIX}webhook:${source}`;
}

/** Org principals: `vendo:org:<orgId>`. Derived from the Vendo-owned org id,
    inside the reserved namespace, so an org subject is collision-proof against
    anything a host resolver can mint. */
export const ORG_SUBJECT_PREFIX = `${RESERVED_SUBJECT_PREFIX}org:`;

export function orgSubject(orgId: string): string {
  return `${ORG_SUBJECT_PREFIX}${orgId}`;
}

export function isOrgSubject(subject: string): boolean {
  return subject.startsWith(ORG_SUBJECT_PREFIX);
}

export function orgIdFromSubject(subject: string): string | null {
  const id = isOrgSubject(subject) ? subject.slice(ORG_SUBJECT_PREFIX.length) : "";
  return id.length > 0 ? id : null;
}

export function orgPrincipal(orgId: string, display?: string): Principal {
  return { kind: "org", subject: orgSubject(orgId), ...(display === undefined ? {} : { display }) };
}
