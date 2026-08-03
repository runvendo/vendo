import { loadRun } from "../../../../runner/store";
import { isSafeName, runsDir } from "../../paths";

export const dynamic = "force-dynamic";

/** GET → the full RunRecord (per-lane artifacts rehydrated) for one run. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!isSafeName(id)) return new Response("invalid run id", { status: 400 });
  try {
    return Response.json(loadRun(runsDir, id));
  } catch {
    return new Response(`run not found: ${id}`, { status: 404 });
  }
}
