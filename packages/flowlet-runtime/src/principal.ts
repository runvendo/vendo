/**
 * Identifies the user on whose behalf the agent is acting.
 *
 * `userId` scopes external connected accounts. `roles` and `limits` feed the
 * guardrail policy engine — a principal with no roles/limits gets default
 * (most restrictive) policy treatment.
 */
export interface FlowletPrincipal {
  userId: string;
  roles?: string[];
  limits?: Record<string, number>;
}
