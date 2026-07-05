/**
 * POST /api/vendo/action — the stage action host.
 *
 * A generated sandbox component's vendo.dispatch lands here; handleStageAction
 * runs it through the SAME demoPolicy that governs agent tool calls and executes
 * allowed actions against the SAME in-process demo tools.
 */
import { handleStageAction } from "@/vendo/action-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleStageAction(req);
}
