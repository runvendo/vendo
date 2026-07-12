import type { Principal } from "@vendoai/core";

/** 10-mcp §3 — the two-function seam. The door owns ALL protocol mechanics
 * (PKCE, resource binding, token issuance/rotation, client registration,
 * metadata documents, its own state via `store`); the host owns exactly:
 * who is this user, and did they consent. */
export interface HostOAuthAdapter {
  /** The interactive consent step: authenticate the user with the HOST's
   * existing session machinery and confirm scope consent. Returns the host
   * subject on success. */
  authorize(
    req: Request,
    ctx: { clientName: string; scopes: string[] },
  ): Promise<Response | { subject: string }>;
  /** Resolve a host subject to the Principal the door executes as (same shape
   * as 09 §2). Resolved on EVERY door request; `null` → 401, token dead —
   * this IS revocation. */
  principal(subject: string): Promise<Principal | null>;
}
