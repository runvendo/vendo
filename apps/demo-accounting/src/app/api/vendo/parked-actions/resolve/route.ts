/** POST /api/vendo/parked-actions/resolve — see parked-actions-handler.ts. */
import { handleDemoParkedActionResolve } from "@/vendo/parked-actions-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleDemoParkedActionResolve(req);
}
