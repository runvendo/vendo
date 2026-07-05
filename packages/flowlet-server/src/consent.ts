/**
 * POST /api/flowlet/consent — the handler-side mount of the runtime's
 * `handleConsent` (ENG-193 §4.5). Follows action.ts's conventions: body
 * validation → 400, principal/guard handled by the caller (handler.ts runs
 * `resolvePrincipal` before dispatching here), result statuses pass through.
 */
import { handleConsent } from "@flowlet/runtime";
import type { ConsentLedger, FadeTracker, ToolDescriptor } from "@flowlet/runtime";
import type { AuditLog, GrantStore, Principal, ThreadStore } from "@flowlet/core";
import { consentResponseSchema } from "@flowlet/core";
import type { ThreadIndex } from "./threads";

export interface ConsentRouteDeps {
  grants: GrantStore;
  audit: AuditLog;
  threads: ThreadStore;
  threadIndex: ThreadIndex;
  resolveDescriptor: (toolName: string) => ToolDescriptor | undefined;
  /** ENG-193 §4.4 — optional (absent -> no fade tracking passthrough). */
  fadeTracker?: FadeTracker;
  /** Review follow-up — optional (absent -> no dedup passthrough); the ONE
   *  ledger the handler constructs at assembly time (see handler.ts). */
  seen?: ConsentLedger;
  principal: Principal;
}

interface ConsentBody {
  id?: string; // the ai SDK chat id — same body key /chat receives
  toolCallId?: string;
  toolName?: string;
  response?: unknown;
}

export async function handleConsentRoute(req: Request, deps: ConsentRouteDeps): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as ConsentBody;
  const parsedResponse = consentResponseSchema.safeParse(body.response);
  if (
    typeof body.id !== "string" ||
    typeof body.toolCallId !== "string" ||
    typeof body.toolName !== "string" ||
    !parsedResponse.success
  ) {
    return Response.json({ error: "malformed consent request" }, { status: 400 });
  }
  const threadId = await deps.threadIndex.resolve(deps.principal, body.id);
  const result = await handleConsent(
    {
      grants: deps.grants,
      audit: deps.audit,
      resolveDescriptor: deps.resolveDescriptor,
      getMessages: (scope, id) => deps.threads.getMessages(scope, id),
      fadeTracker: deps.fadeTracker,
      seen: deps.seen,
    },
    deps.principal,
    { threadId, toolCallId: body.toolCallId, toolName: body.toolName, response: parsedResponse.data },
  );
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true, ...(result.fadeEligible ? { fadeEligible: result.fadeEligible } : {}) });
}
