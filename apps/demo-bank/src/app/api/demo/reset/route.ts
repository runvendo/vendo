import { __reseed } from "@/server/store";
import { ok } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  __reseed(new Date());
  // VENDO-MIGRATION: the v0 wire owns grants, threads, and connector state;
  // it does not expose the legacy demo-only connection reset hook.
  return ok({ reset: true });
}
