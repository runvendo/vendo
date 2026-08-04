import { setPin } from "../../../runner/store";
import { isSafeName, runsDir } from "../paths";

export const dynamic = "force-dynamic";

/** POST {id, pin} — pin is the label string; null/absent unpins. Returns the
 *  updated slim RunRecord. */
export async function POST(request: Request): Promise<Response> {
  let body: { id?: string; pin?: string | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  if (typeof body.id !== "string" || !isSafeName(body.id)) {
    return new Response("invalid run id", { status: 400 });
  }
  if (body.pin != null && typeof body.pin !== "string") {
    return new Response("pin must be a string or null", { status: 400 });
  }
  try {
    return Response.json(setPin(runsDir, body.id, body.pin ?? undefined));
  } catch {
    return new Response(`run not found: ${body.id}`, { status: 404 });
  }
}
