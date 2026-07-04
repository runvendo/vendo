/** POST /api/flowlet/grants/revoke — see trust-handler.ts. */
import { handleDemoGrantsRevoke } from "@/flowlet/trust-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleDemoGrantsRevoke(req);
}
