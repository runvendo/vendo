import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { saveRun } from "./store";
import type {
  HostFixture,
  HostName,
  LaneAdapter,
  LaneName,
  LaneResult,
  LaneRunOptions,
  RunRecord,
  RunRequest,
} from "./types";

export interface GitState {
  sha: string;
  /** sha256 of `git diff` when the tree is dirty, else null. */
  dirty: string | null;
}

export interface ExecuteRunOptions {
  /** Injectable for tests; defaults to shelling out to git from cwd. */
  readGitState?: () => GitState | Promise<GitState>;
}

/**
 * The single generation path (cockpit and CLI are both thin callers): run the
 * requested lanes concurrently against the host fixture, persist the
 * RunRecord + artifacts under `runsDir`, and return the full record. Never
 * rejects — every lane failure (adapter throw, missing adapter, unknown
 * host) lands as a per-lane `status:"failed"`.
 */
export async function executeRun(
  req: RunRequest,
  fixtures: Partial<Record<HostName, HostFixture>>,
  adapters: LaneAdapter[],
  runsDir: string,
  options: ExecuteRunOptions = {},
): Promise<RunRecord> {
  const fixture = fixtures[req.host];
  const byName = new Map(adapters.map((adapter) => [adapter.name, adapter]));

  const laneOptions: LaneRunOptions = req.model ? { model: req.model } : {};
  const settled = await Promise.allSettled(
    req.lanes.map((lane) =>
      runLane(lane, byName.get(lane), req.prompt, fixture, req.host, laneOptions),
    ),
  );
  const lanes: RunRecord["lanes"] = {};
  req.lanes.forEach((lane, index) => {
    const outcome = settled[index];
    // runLane never rejects; the belt below keeps a runner bug from
    // rejecting the whole run.
    lanes[lane] =
      outcome.status === "fulfilled"
        ? outcome.value
        : { status: "failed", startedAt: Date.now(), durationMs: 0, error: String(outcome.reason) };
  });

  const git = await (options.readGitState ?? readGitStateFromCli)();
  const record: RunRecord = {
    id: newRunId(),
    createdAt: new Date().toISOString(),
    gitSha: git.sha,
    gitDirty: git.dirty,
    request: req,
    lanes,
  };
  saveRun(runsDir, record);
  return record;
}

async function runLane(
  lane: LaneName,
  adapter: LaneAdapter | undefined,
  prompt: string,
  fixture: HostFixture | undefined,
  host: HostName,
  options: LaneRunOptions,
): Promise<LaneResult> {
  const startedAt = Date.now();
  const failed = (error: string): LaneResult => ({
    status: "failed",
    startedAt,
    durationMs: Date.now() - startedAt,
    error,
  });
  if (!adapter) return failed(`no adapter registered for lane "${lane}"`);
  if (!fixture) return failed(`no host fixture for "${host}"`);
  try {
    return await adapter.generate(prompt, fixture, options);
  } catch (error) {
    // Adapters promise not to throw; catch anyway so one lane can never
    // take down the run.
    return failed(error instanceof Error ? error.message : String(error));
  }
}

/** `${yyyymmdd-hhmmss}-${4 hex}` — sortable, collision-safe enough for one dir. */
function newRunId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

function readGitStateFromCli(): GitState {
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
  const sha = git("rev-parse", "HEAD").trim();
  const diff = git("diff");
  const dirty = diff.trim() === "" ? null : createHash("sha256").update(diff).digest("hex");
  return { sha, dirty };
}
