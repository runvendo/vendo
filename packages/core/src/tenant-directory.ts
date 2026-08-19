import { z } from "zod";
import { membershipSchema, type Membership } from "./run-context.js";

/**
 * THE seam both repos parse: what `GET /api/v1/users/{externalId}/memberships`
 * answers. The console produces it, the SDK's `cloudDirectory` consumes it, and
 * there is exactly one definition of it — a second copy is how a permission or
 * a cap comes to mean two things.
 */

/** A cap and WHO it applies to. `per-member` counts one person's own usage;
    `per-tenant` counts the whole company's, against the `org:<tenantId>` pool.
    The customer picks per cap. Both spellings are the limiter's existing
    grammar — the scope only decides whether `count` is handed a `pool`
    (`@vendoai/vendo` limits.ts) — so nothing new enforces anything. */
export type CapScope = "per-member" | "per-tenant";
export interface TenantCap { limit: number; scope: CapScope }

export interface TenantLimits {
  messagesPerDay?: TenantCap;
  generationsPerMonth?: TenantCap;
}

export const capScopeSchema = z.enum(["per-member", "per-tenant"]);
export const tenantCapSchema = z.object({
  limit: z.number().int().positive(),
  scope: capScopeSchema,
}).passthrough() satisfies z.ZodType<TenantCap>;
export const tenantLimitsSchema = z.object({
  messagesPerDay: tenantCapSchema.optional(),
  generationsPerMonth: tenantCapSchema.optional(),
}).passthrough() satisfies z.ZodType<TenantLimits>;

/** Applied by the console when a cap is first written and nowhere else, so the
    wire never carries an implicit scope: reading a cap always tells you both
    numbers' meaning. */
export const DEFAULT_CAP_SCOPE = {
  messagesPerDay: "per-member",
  generationsPerMonth: "per-tenant",
} as const satisfies Record<keyof TenantLimits, CapScope>;

/** `memberships` is core's own `Membership[]` verbatim — `org` IS the tenant
    id, so nothing downstream translates. `limits` is keyed by that same id and
    already resolved (per-tenant override ?? project default), so the SDK never
    sees defaults. */
export interface TenantDirectoryPayload {
  memberships: Membership[];
  limits: Record<string, TenantLimits>;
}

export const tenantDirectoryPayloadSchema = z.object({
  memberships: z.array(membershipSchema),
  limits: z.record(tenantLimitsSchema),
}).passthrough() satisfies z.ZodType<TenantDirectoryPayload>;
