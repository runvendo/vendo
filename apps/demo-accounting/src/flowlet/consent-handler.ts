/**
 * POST /api/flowlet/consent — mounts `handleConsent` (ENG-193 §4.5) behind
 * this app's own hand-rolled route, the same way every other Flowlet route
 * here is a thin adapter over a testable handler function (see
 * chat-handler.ts/action-handler.ts). The `@flowlet/next` production mount of
 * the SAME runtime logic lives in packages/flowlet-next/src/consent.ts; this
 * app hasn't migrated to the handler ("Plan deviations" #1).
 *
 * `grant.tool` is already server-bound inside `handleConsent` itself (it 400s
 * when `response.grant.tool !== toolName`) — no need to re-check it here.
 */
import { handleConsent, type HandleConsentRequest } from "@flowlet/runtime";
import { consentResponseSchema } from "@flowlet/core";
import { demoStore, resolveThreadRecordId, CADENCE_SCOPE } from "./store";
import { resolveToolDescriptor } from "./tool-registry";
import { demoPrincipalAllowed, LOCAL_ONLY_MESSAGE } from "./local-guard";

interface ConsentBody {
  id?: string; // client chat/thread id, same field chat-handler reads
  toolCallId?: string;
  toolName?: string;
  response?: unknown;
}

export async function handleDemoConsent(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) {
    return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  }
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
  const threadId = await resolveThreadRecordId(CADENCE_SCOPE, body.id);
  const consentReq: HandleConsentRequest = {
    threadId, toolCallId: body.toolCallId, toolName: body.toolName, response: parsedResponse.data,
  };
  // RACE WINDOW (single-client v1): the approval part this reads is written by
  // the engine's fire-and-forget onSettled hook (agent.ts) after the run's
  // stream settles. A consent POST racing that write 404s. In practice the run
  // settles (and persists) when it pauses at the approval — human reaction
  // time dwarfs the in-memory write — so v1 accepts the window. A cloud
  // ThreadStore must close it properly: await the persistence before serving
  // consent, or retry the lookup on miss.
  const result = await handleConsent(
    {
      grants: demoStore.grants,
      audit: demoStore.audit,
      resolveDescriptor: resolveToolDescriptor,
      getMessages: (scope, id) => demoStore.threads.getMessages(scope, id),
    },
    CADENCE_SCOPE,
    consentReq,
  );
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
}
