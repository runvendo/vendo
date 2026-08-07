import type { Principal } from "@vendoai/core";

export interface HostOAuthConsentFlow {
  /** Submit approve/deny here with application/x-www-form-urlencoded. */
  action: string;
  /** Hidden `transaction` value. Single-use; an approved replay is rejected. */
  transaction: string;
  /** Hidden `csrf_token` value. */
  csrfToken: string;
}

export interface HostOAuthAuthorizeContext {
  clientName: string;
  scopes: string[];
  /** Present when `session` selects the door-owned flow. A custom page posts
   * `transaction`, `csrf_token`, and `decision=approve|deny` to `action`; the
   * door still owns CSRF, replay protection, and the OAuth redirect. */
  consent?: HostOAuthConsentFlow;
}

export interface HostOAuthSessionContext {
  /** Exact authorization URL the host login must return to. Supplying this
   * removes the common redirect-to-login/authorize loop from host code. */
  returnTo: string;
}

/** 10-mcp §3 plus the additive prebuilt-consent path. The door owns ALL protocol mechanics
 * (PKCE, resource binding, token issuance/rotation, client registration,
 * metadata documents, its own state via `store`) and, when `session` is used,
 * the consent decision UI too. */
export interface HostOAuthAdapter {
  /** Legacy/full-page escape hatch. Without `session`, this retains its original
   * semantics: authenticate + consent and return a subject, or return a Response.
   * With `session`, returning a Response replaces the consent page while the
   * door-owned POST flow remains intact through `ctx.consent`. */
  authorize?(
    req: Request,
    ctx: HostOAuthAuthorizeContext,
  ): Promise<Response | { subject: string }>;
  /** Select the prebuilt flow. Return the current host subject, or a login
   * Response that redirects through `ctx.returnTo` when no session exists. */
  session?(
    req: Request,
    ctx: HostOAuthSessionContext,
  ): Promise<Response | { subject: string }>;
  /** Resolve a host subject to the Principal the door executes as (same shape
   * as 09 §2). Resolved on EVERY door request; `null` → 401, token dead —
   * this IS revocation. */
  principal(subject: string): Promise<Principal | null>;
}
