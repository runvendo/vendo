/**
 * POST /api/flowlet/action — the stage action host.
 *
 * A generated sandbox component's flowlet.dispatch lands here; handleStageAction
 * runs it through the SAME demoPolicy that governs agent tool calls and executes
 * allowed actions against the SAME in-process demo tools. The local-only guard
 * (principalAllowed) is private to chat-handler; this route is a thin wrapper and
 * relies on the policy itself (writes require approval) as the governing door.
 */
import { handleStageAction } from "@/flowlet/action-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleStageAction(req);
}
