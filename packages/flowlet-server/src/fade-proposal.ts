/**
 * POST /api/flowlet/fade-proposal — the handler-side mount of the runtime's
 * `handleFadeProposal` (ENG-193 §4.4). Keyed by proposalId, not toolCallId —
 * see fade-proposal.ts's own docstring for why this isn't `/consent`.
 */
import { handleFadeProposal } from "@flowlet/runtime";
import type { FadeTracker, ToolDescriptor } from "@flowlet/runtime";
import type { AuditLog, GrantStore, Principal } from "@flowlet/core";
import { fadeProposalResolutionSchema } from "@flowlet/core";

export interface FadeProposalRouteDeps {
  fadeTracker: FadeTracker;
  grants: GrantStore;
  audit: AuditLog;
  resolveDescriptor: (toolName: string) => ToolDescriptor | undefined;
  principal: Principal;
}

export async function handleFadeProposalRoute(req: Request, deps: FadeProposalRouteDeps): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const parsed = fadeProposalResolutionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "malformed fade-proposal request" }, { status: 400 });
  const result = await handleFadeProposal(
    { fadeTracker: deps.fadeTracker, grants: deps.grants, audit: deps.audit, resolveDescriptor: deps.resolveDescriptor },
    deps.principal,
    parsed.data,
  );
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
}
