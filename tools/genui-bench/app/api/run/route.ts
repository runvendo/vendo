import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadRun } from "../../../runner/store";
import type { HostName, LaneName, RunRequest } from "../../../runner/types";
import { appDir, runsDir } from "../paths";

const execFileAsync = promisify(execFile);

const HOSTS: HostName[] = ["maple", "cadence"];
const LANES: LaneName[] = ["vendo", "thesys-c1", "copilotkit", "tambo"];

export const dynamic = "force-dynamic";

/** POST {prompt, host, lanes, packRef?} → full RunRecord (artifacts
 *  rehydrated). The run itself executes in a tsx subprocess (see exec-run.ts
 *  for why); the response resolves when all lanes have settled — the cockpit
 *  shows the running state client-side and polls /api/runs for the rail. */
export async function POST(request: Request): Promise<Response> {
  let body: Partial<RunRequest>;
  try {
    body = (await request.json()) as Partial<RunRequest>;
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
    return new Response("prompt is required", { status: 400 });
  }
  if (!body.host || !HOSTS.includes(body.host)) {
    return new Response(`host must be one of ${HOSTS.join("|")}`, { status: 400 });
  }
  if (!Array.isArray(body.lanes) || body.lanes.some((lane) => !LANES.includes(lane))) {
    return new Response(`lanes must be a subset of ${LANES.join("|")}`, { status: 400 });
  }
  const runRequest: RunRequest = {
    prompt: body.prompt.trim(),
    host: body.host,
    lanes: body.lanes,
    ...(body.packRef ? { packRef: body.packRef } : {}),
  };

  try {
    const { stdout } = await execFileAsync(
      join(appDir, "node_modules", ".bin", "tsx"),
      [join(appDir, "app", "api", "run", "exec-run.ts"), JSON.stringify(runRequest), runsDir],
      { cwd: appDir, timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const lastLine = stdout.trim().split("\n").pop() ?? "";
    const { id } = JSON.parse(lastLine) as { id: string };
    return Response.json(loadRun(runsDir, id));
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    return new Response(`run failed: ${detail}`, { status: 500 });
  }
}
