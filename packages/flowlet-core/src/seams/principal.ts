/**
 * The verified identity every seam operation is scoped to.
 * - Embedded: derived in-process from the host session (tenant is implicit;
 *   embedded hosts may use a fixed tenantId).
 * - Cloud: derived from the vouch JWT at session init (Decision 4); users are
 *   unique per (tenant, subject), no PII beyond the vouch claims.
 */
export interface Principal {
  tenantId: string;
  /** The host's stable user identifier (the vouch `sub`). */
  subject: string;
  /** Vouch claims passed through verbatim (roles, plan, etc.). */
  claims?: Record<string, unknown>;
}
