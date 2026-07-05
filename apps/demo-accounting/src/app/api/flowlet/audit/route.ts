/** GET /api/flowlet/audit — see trust-handler.ts. */
import { handleDemoAuditQuery } from "@/flowlet/trust-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleDemoAuditQuery(req);
}
