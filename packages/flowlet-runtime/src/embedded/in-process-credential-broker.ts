/**
 * Embedded implementation of the frozen CredentialBroker seam: the host runs
 * the runtime in-process, so `authenticate` is a shape-checked pass-through of
 * the host-supplied Principal and `acquireGrant` returns the ambient identity
 * as a short-lived non-secret token (seam doc: "authenticate is a
 * pass-through, acquireGrant returns the ambient identity"). No JWT, no token
 * exchange — that is the cloud implementation.
 */
import type { BrokeredGrant, CredentialBroker, GrantRequest, Principal } from "@flowlet/core";

const DEFAULT_GRANT_TTL_MS = 15 * 60 * 1000;

function isPrincipal(value: unknown): value is Principal {
  if (value === null || typeof value !== "object") return false;
  const p = value as Partial<Principal>;
  return typeof p.tenantId === "string" && typeof p.subject === "string";
}

export interface InProcessCredentialBrokerConfig {
  nowMs?: () => number;
  grantTtlMs?: number;
}

export class InProcessCredentialBroker implements CredentialBroker {
  private readonly nowMs: () => number;
  private readonly grantTtlMs: number;

  constructor(config: InProcessCredentialBrokerConfig = {}) {
    this.nowMs = config.nowMs ?? Date.now;
    this.grantTtlMs = config.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
  }

  async authenticate(credential: unknown): Promise<Principal> {
    if (!isPrincipal(credential)) {
      throw new Error(
        "InProcessCredentialBroker.authenticate expects a Principal ({ tenantId, subject }) from the host",
      );
    }
    return credential;
  }

  async acquireGrant(request: GrantRequest): Promise<BrokeredGrant> {
    const { principal, automationId, scopes } = request;
    return {
      token: `embedded:${principal.tenantId}:${principal.subject}:${automationId}`,
      expiresAt: new Date(this.nowMs() + this.grantTtlMs).toISOString(),
      scopes: [...scopes],
    };
  }
}
