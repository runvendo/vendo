/** POST /api/flowlet/rules/revoke — see trust-handler.ts. */
import { handleDemoRulesRevoke } from "@/flowlet/trust-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleDemoRulesRevoke(req);
}
