/** GET /api/flowlet/grants — see trust-handler.ts. */
import { handleDemoGrantsList } from "@/flowlet/trust-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleDemoGrantsList(req);
}
