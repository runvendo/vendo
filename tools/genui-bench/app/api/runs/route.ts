import { listRuns } from "../../../runner/store";
import { runsDir } from "../paths";

export const dynamic = "force-dynamic";

/** GET → { runs: RunRecord[] } — slim records (no artifacts), newest-first.
 *  Agent CLI runs land in the same runs/ dir, so they appear here too. */
export async function GET(): Promise<Response> {
  return Response.json({ runs: listRuns(runsDir) });
}
