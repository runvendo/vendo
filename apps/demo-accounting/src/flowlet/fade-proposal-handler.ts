/**
 * POST /api/flowlet/fade-proposal — mounts `handleFadeProposal` (ENG-193
 * §4.4) behind this app's own hand-rolled route, same pattern as
 * consent-handler.ts.
 */
import { handleFadeProposal } from "@flowlet/runtime";
import { fadeProposalResolutionSchema } from "@flowlet/core";
import { demoStore, CADENCE_SCOPE } from "./store";
import { resolveToolDescriptor } from "./tool-registry";
import { demoPrincipalAllowed, LOCAL_ONLY_MESSAGE } from "./local-guard";

export async function handleDemoFadeProposal(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const parsed = fadeProposalResolutionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "malformed fade-proposal request" }, { status: 400 });
  const result = await handleFadeProposal(
    {
      fadeTracker: demoStore.fadeTracker, grants: demoStore.grants, audit: demoStore.audit,
      resolveDescriptor: resolveToolDescriptor,
    },
    CADENCE_SCOPE,
    parsed.data,
  );
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
}
