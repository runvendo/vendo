/** GET /api/vendo/parked-actions — see parked-actions-handler.ts. */
import { handleDemoParkedActionsList } from "@/vendo/parked-actions-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return handleDemoParkedActionsList(req);
}
