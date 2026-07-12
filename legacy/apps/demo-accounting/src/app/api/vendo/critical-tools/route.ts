/** GET /api/vendo/critical-tools — see trust-handler.ts. */
import { handleDemoCriticalTools } from "@/vendo/trust-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleDemoCriticalTools(req);
}
