/** POST /api/flowlet/consent — see consent-handler.ts. */
import { handleDemoConsent } from "@/flowlet/consent-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleDemoConsent(req);
}
