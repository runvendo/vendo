import { resetDb } from "../../../lib/db";

export function POST(): Response {
  resetDb();
  return Response.json({ ok: true });
}
