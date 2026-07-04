/** POST /api/flowlet/fade-proposal — see fade-proposal-handler.ts. */
import { handleDemoFadeProposal } from "@/flowlet/fade-proposal-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleDemoFadeProposal(req);
}
