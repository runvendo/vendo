/** GET /api/flowlet/critical-tools — see trust-handler.ts. */
import { handleDemoCriticalTools } from "@/flowlet/trust-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleDemoCriticalTools(req);
}
