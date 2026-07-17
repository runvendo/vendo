import { z } from "zod";

/** 01-core §2. `kind: "org"` is kept as a reserved principal shape (the org
    storage layer that made it real — membership roles, minting/parsing
    helpers — was cut under kill-list §A5; orgs live on the Vendo-hosted side
    now). Whether v2 re-derives org principals is a contract decision, deferred
    rather than made here. */
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
    (it only ever appeared on audit events for rejected deliveries).

    Note: the reserved namespace also carries `vendo:org:<id>` subjects
    (`isReservedSubject` rejects them the same as any other `vendo:`-prefixed
    subject), but the org-specific minting/parsing helpers that used to live
    here were removed with the org storage layer (kill-list §A5) — the
    `kind: "org"` principal shape and the reserved namespace itself stay;
    whether v2 core re-derives org-subject helpers is a contract decision, not
    made here. */
export function webhookSubject(source: string): string {
  return `${RESERVED_SUBJECT_PREFIX}webhook:${source}`;
}
