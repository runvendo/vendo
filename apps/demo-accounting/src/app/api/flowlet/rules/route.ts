/** GET /api/flowlet/rules — see trust-handler.ts. */
import { handleDemoRulesList } from "@/flowlet/trust-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleDemoRulesList(req);
}
