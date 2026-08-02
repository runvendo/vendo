// GET /api/demo/chips — the signed-in user's "try this" chip manifest. The
// thread renders one chip per entry; an empty manifest (pre-generation still
// running, or a non-demo user) means no chip row at all.
import { resolveMapleSession } from "@/vendo/auth";
import { readChipManifest } from "@/vendo/chips";
import { ok } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await resolveMapleSession(request);
  if (user === null) return ok({ chips: [] });
  const chips = await readChipManifest(user.subject);
  return ok({ chips: chips.map(({ key, prompt }) => ({ key, prompt })) });
}
