import type { Principal } from "./principal.js";

/**
 * CredentialBroker seam — how a tool call gets user identity (Decisions 1/4).
 *
 * | Deployment | Implementation |
 * |---|---|
 * | Embedded | host session, in-process; `authenticate` is a pass-through, `acquireGrant` returns the ambient identity |
 * | Cloud | vouch JWT verification at session init + RFC 8693-shaped token exchange for automations |
 *
 * Interactive host-API calls need NO credential from this seam at all — the
 * browser executes them on the user's existing session (Decision 2). The
 * broker covers the other two credential lifetimes: session identity and the
 * short-lived brokered grant automations run under.
 */
export interface CredentialBroker {
  /**
   * Turn the SDK-presented credential into a verified Principal at session
   * init. Cloud: the vouch JWT string. Embedded: whatever the host passes
   * in-process (opaque here).
   */
  authenticate(credential: unknown): Promise<Principal>;

  /**
   * Exchange a signed assertion for a short-lived scoped user token, held only
   * for one automation run. Revocation lives on the host side. Only required
   * once a tenant enables automations.
   */
  acquireGrant(request: GrantRequest): Promise<BrokeredGrant>;
}

export interface GrantRequest {
  principal: Principal;
  automationId: string;
  /** Scopes pre-authorized at automation creation (Decision 4). */
  scopes: string[];
}

export interface BrokeredGrant {
  /** Bearer token for host-API calls during this run. Never persisted. */
  token: string;
  /** ISO 8601 expiry; the run must not outlive it without re-exchange. */
  expiresAt: string;
  scopes: string[];
}
