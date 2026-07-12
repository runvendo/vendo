import { z } from "zod";
import type { Principal } from "./principal.js";

/**
 * PermissionGrant — the ONE primitive behind every remembered consent
 * (ENG-193 spec §4.3). A grant records that this principal said yes to this
 * kind of action within these bounds. Scope is STRUCTURED (renderable on the
 * Trust screen) — a hash is computed from it for matching, never stored as
 * the only representation. Automation pre-auth grants stay version-bound in
 * the automation store; this contract covers chat/fade/rule grants.
 */
export const grantConstraintSchema = z
  .object({
    /** Dot-path into the tool input, e.g. "to" or "invoice.amount". */
    path: z.string().min(1),
    op: z.enum(["eq", "lte", "gte", "matches"]),
    value: z.union([z.string(), z.number(), z.boolean()]),
  })
  .strict();
export type GrantConstraint = z.infer<typeof grantConstraintSchema>;

export const grantScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool") }).strict(),
  z
    .object({
      kind: z.literal("exact"),
      inputHash: z.string(),
      /** Human-readable snapshot for the Trust screen. */
      inputPreview: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("constrained"),
      constraints: z.array(grantConstraintSchema).min(1),
    })
    .strict(),
]);
export type GrantScope = z.infer<typeof grantScopeSchema>;

export const grantDurationSchema = z.enum(["standing", "session", "task"]);
export type GrantDuration = z.infer<typeof grantDurationSchema>;

export const grantSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat") }).strict(),
  z.object({ kind: z.literal("fade") }).strict(),
  z.object({ kind: z.literal("compiled-rule"), rule: z.string().optional() }).strict(),
]);
export type GrantSource = z.infer<typeof grantSourceSchema>;

export const permissionGrantSchema = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    subject: z.string(),
    tool: z.string(),
    /** Tool descriptor fingerprint at grant time — drift lapses the grant. */
    descriptorHash: z.string(),
    scope: grantScopeSchema,
    duration: grantDurationSchema,
    /** Binds session/task-duration grants to their context; unset for standing. */
    contextKey: z.string().optional(),
    source: grantSourceSchema,
    grantedAt: z.string(),
    revokedAt: z.string().optional(),
    expiresAt: z.string().optional(),
  })
  .strict();
export type PermissionGrant = z.infer<typeof permissionGrantSchema>;

/**
 * GrantStore seam. The store assigns `id`, `tenantId`, `subject`, and
 * `grantedAt` (`revokedAt` starts unset) — callers never supply them (house
 * authorship rule). Truth lives server-side where policy evaluates; clients
 * only read through this seam.
 */
export interface GrantStore {
  create(
    scope: Principal,
    grant: Omit<PermissionGrant, "id" | "tenantId" | "subject" | "grantedAt" | "revokedAt">,
  ): Promise<PermissionGrant>;
  list(scope: Principal): Promise<PermissionGrant[]>;
  revoke(scope: Principal, id: string): Promise<void>;
  /** Unrevoked grants for one tool — the policy-time lookup. Excludes revoked
   *  grants only; expiry is evaluated at match time by the policy layer. */
  findForTool(scope: Principal, tool: string): Promise<PermissionGrant[]>;
}
