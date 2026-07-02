/**
 * The stage action host — the bridge between sandbox dispatches and the
 * guardrail policy. A generated component's flowlet.dispatch lands here (via
 * POST /api/flowlet/action): the SAME demoPolicy that governs agent tool calls
 * decides allow/approve/deny, and allowed actions execute against the SAME
 * in-process demo tools the agent uses.
 *
 * Approval flow (demo-grade): an `approve` decision returns { needsApproval }
 * without executing; the client shows a prompt and re-POSTs with approved:true.
 * The re-POST is trusted — acceptable for the local-only demo. SAFETY
 * INVARIANT: every in-process demo tool is read-only and in ALWAYS_ALLOW
 * (→allow, executes directly) and every approve-shaped name has NO in-process
 * `execute` (→404, never runs) — so no approve-gated action can reach the
 * execute line via a forged re-POST. If a WRITE tool is ever added to
 * demoTools(), a server-side approval token becomes required here.
 */
import { demoTools } from "./tools";
import { demoPolicy } from "./policy";
import { DEMO_PRINCIPAL } from "./principal";
import { buildDescriptor } from "@flowlet/runtime";

interface ActionBody {
  action?: string;
  payload?: unknown;
  approved?: boolean;
}

export async function handleStageAction(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as ActionBody;
  if (typeof body.action !== "string" || body.action.length === 0) {
    return Response.json({ error: "action (string) is required" }, { status: 400 });
  }

  const tools = demoTools() as Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }>;
  const tool = tools[body.action];

  const decision = await demoPolicy.evaluate({
    toolName: body.action,
    input: body.payload ?? {},
    descriptor: buildDescriptor(body.action, tool, "caller"),
    principal: DEMO_PRINCIPAL,
  });

  if (decision === "deny") {
    return Response.json({ decision, error: "denied by policy" }, { status: 403 });
  }
  if (decision === "approve" && body.approved !== true) {
    return Response.json({ decision, needsApproval: true });
  }
  if (!tool?.execute) {
    return Response.json({ error: `unknown action "${body.action}"` }, { status: 404 });
  }
  const result = await tool.execute(body.payload ?? {}, { toolCallId: "stage-action", messages: [] });
  return Response.json({ decision, result });
}
