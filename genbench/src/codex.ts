/**
 * The codex contender — the strong in-house baseline on the other side of the
 * house: OpenAI's own coding agent, headless, working in a scratch directory and
 * writing and rewriting one page. It is the peer of `claude-code` in everything
 * the comparison rests on — the SAME world block, the same harness contract and
 * the same case prompt, in the same bytes — and differs only in whose engine
 * holds the pen.
 *
 * It is billed by its OWN session, not by genbench's metered model: the CLI
 * spawns its own engine and never touches `meter.model`. So the tokens ride the
 * outcome instead, priced through the same `usdFor` table as every other column.
 * The meter is still the run's clock, and the only one.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_IDS, usdFor, type ModelAlias, type UsageTally } from "./meter.js";
import { HARNESS_CONTRACT } from "./render.js";
import type { Contender, RunOutcome, RunRequest } from "./run.js";
import { installWorldTools, TOOL_ACCESS, worldBlock } from "./vendo.js";
import type { Case, World } from "./world.js";

/** The bits of a `codex exec` process this driver uses: the `--json` stream it
 *  prints, and a way to end it. */
export interface CodexSession {
  /** stdout as it arrives — chunks, which need not be whole lines. */
  readonly output: AsyncIterable<string>;
  kill(): void;
}

/** Test seam, at the process boundary the way `claude-code`'s is at the SDK's:
 *  everything above it — the workspace, the brief, the event stream, the wall
 *  clock — is the driver's own behaviour under test. */
export type CodexSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
) => CodexSession;

export interface CodexOptions {
  /** Which model the session thinks with. The run's matrix picks it. */
  readonly model: ModelAlias;
  /** Test seam — production spawns the pinned CLI. */
  readonly spawn?: CodexSpawn;
  /** Test seam; production uses {@link WALL_CLOCK_MS}. */
  readonly timeoutMs?: number;
}

/** Agentic builds are slower than one generation call — a wall clock, not a
 *  step count. Exported because this column's case budget in `run.ts` has to
 *  outlast it: a case that ends first would report a timeout the contender
 *  never had. */
export const WALL_CLOCK_MS = 10 * 60_000;

/** How long a session that outran the wall clock gets to stop being asked
 *  before it is made to. */
const KILL_GRACE_MS = 2_000;

const PAGE = "index.html";

/** Where this contender leaves its page, and nothing else — every rule the page
 *  itself has to satisfy is the shared `HARNESS_CONTRACT`, in the bytes every
 *  other page-writing column is handed. */
const DELIVERY = `Write ONE file, \`${PAGE}\`, in your working directory: a complete document, saved over again each time you revise it. Nothing else is read.`;

const brief = (world: World, testCase: Case): string =>
  [worldBlock(world), "", DELIVERY, "", TOOL_ACCESS, "", HARNESS_CONTRACT, "", `TASK: ${testCase.prompt}`].join("\n");

/** The pinned devDependency's own binary, never a bare `codex`: the operator's
 *  global install is some other version, and which engine wrote the page is part
 *  of what a run reports. */
const CODEX = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "codex");

/**
 * The whole invocation, in one place.
 *
 * `workspace-write` is the loadout a team really runs headless — and it disables
 * the network, which would handicap this column against `claude-code`'s stock
 * Bash, so the network is turned back on by config override rather than by
 * widening the sandbox to `danger-full-access`. There is no approval flag:
 * `codex exec` never asks, and 0.147.0 rejects `-a` outright.
 */
const invocation = (workspace: string, modelId: string, prompt: string): readonly string[] => [
  "exec",
  "--cd",
  workspace,
  "--sandbox",
  "workspace-write",
  "--skip-git-repo-check",
  "--json",
  "-c",
  "sandbox_workspace_write.network_access=true",
  "-m",
  modelId,
  prompt,
];

/**
 * The subprocess's whole environment, spelled out rather than inherited — the
 * same rule as `claude-code`'s and for the same reason: an `OPENAI_BASE_URL` or
 * a `CODEX_*` left in the operator's shell reshapes this column and no
 * `result.json` would say so.
 *
 * `CODEX_HOME` is the isolation itself: the operator's own `~/.codex` carries
 * private plugins and MCP servers that would silently become this column's
 * advantage, and its state files take locks that parallel sessions fight over.
 *
 * The key goes in under the name the CLI actually reads. It arrives as
 * `OPENAI_API_KEY`, which is the run's one name for it, and leaves as
 * `CODEX_API_KEY`, because 0.147.0 with a fresh home reads neither an
 * `auth.json` (there is none) nor `OPENAI_API_KEY`: it sends no `Authorization`
 * header at all and the first call dies on `401 … Missing bearer`, with a live
 * key sitting right there in the environment.
 */
function sessionEnv(codexHome: string): Record<string, string> {
  const key = process.env["OPENAI_API_KEY"];
  const env: Record<string, string> = {
    CODEX_HOME: codexHome,
    ...(key === undefined ? {} : { CODEX_API_KEY: key }),
  };
  for (const name of ["PATH", "HOME"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** The real process. stdin is IGNORED rather than merely unused: `codex exec`
 *  reads an open non-TTY stdin to the end before it starts, so a pipe nobody
 *  writes to hangs the session for its whole wall clock. stderr goes the same
 *  way — it carries the CLI's tracing rather than the run's events, and a pipe
 *  nobody drains fills up and blocks the child. */
const spawnCodex: CodexSpawn = (command, args, options) => {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "ignore"] });
  const stdout = child.stdout!;
  // A binary that never started would otherwise read as a session that said
  // nothing, which is this column's own way of failing a case.
  child.on("error", (error) => stdout.destroy(error));
  return {
    output: stdout.setEncoding("utf8"),
    kill: () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    },
  };
};

/** One line of the `--json` stream, or nothing: a line the CLI wrote for a
 *  person to read, and the half line a killed process leaves behind, are both
 *  things this driver has no use for. */
const parsed = (line: string): Record<string, unknown> | undefined => {
  if (!line.startsWith("{")) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** The `--json` stream, one event per line. A half line is held until the rest
 *  of it arrives, because stdout chunks do not land on line boundaries. */
async function* events(output: AsyncIterable<string>): AsyncGenerator<Record<string, unknown>> {
  let held = "";
  for await (const chunk of output) {
    const lines = (held + chunk).split("\n");
    held = lines.pop() ?? "";
    for (const line of lines) {
      const event = parsed(line);
      if (event !== undefined) yield event;
    }
  }
  // A stream can end on a whole event with nothing after it, and the last event
  // a session sends is the one carrying its tokens: held back and never flushed,
  // a finished session bills at zero.
  const last = parsed(held);
  if (last !== undefined) yield last;
}

const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** A completed turn's `usage` block in the vocabulary the report already speaks.
 *  `input_tokens` is the WHOLE input including both cache halves, so the full
 *  rate applies to what is left after subtracting them — the same arithmetic
 *  `meteredModel` does for a provider that reports only a total. Reasoning
 *  tokens are a subset of `output_tokens` rather than a number beside it, and
 *  adding them would bill this column's thinking twice. */
function record(totals: UsageTally, raw: unknown): void {
  const usage = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const cacheRead = numberOf(usage["cached_input_tokens"]);
  const cacheWrite = numberOf(usage["cache_write_input_tokens"]);
  totals.inputTokens += Math.max(0, numberOf(usage["input_tokens"]) - cacheRead - cacheWrite);
  totals.outputTokens += numberOf(usage["output_tokens"]);
  totals.cacheReadTokens += cacheRead;
  totals.cacheWriteTokens += cacheWrite;
  totals.calls += 1;
}

/** `turn.failed` carries the CLI's own sentence for how it ended, and the report
 *  should say which failure it was rather than that there was one. */
const failureOf = (event: Record<string, unknown>): string =>
  String((event["error"] as { message?: unknown } | undefined)?.message ?? "the session failed without saying why");

export function codexDriver(options: CodexOptions): Contender {
  return { run: async (request) => await run(request, options) };
}

async function run(request: RunRequest, options: CodexOptions): Promise<RunOutcome> {
  const { world, testCase, meter } = request;
  const modelId = MODEL_IDS[options.model];
  const workspace = await mkdtemp(join(tmpdir(), `genbench-${testCase.id}-`));
  // A SIBLING of the workspace, never a directory inside it: `workspace-write`
  // makes the workspace the only writable place and the CLI's home is state it
  // has to write, so a home under the workspace is a session that cannot start —
  // and one more directory the page's author can see.
  const home = await mkdtemp(join(tmpdir(), "genbench-codex-"));
  // The host's tools, callable, before the session starts: this column has hands,
  // so it gets the same look at the data the vendo column's loop gets. In the
  // workspace because that is the one directory `workspace-write` lets the
  // session see and the one its `--cd` puts it in.
  await installWorldTools(workspace, world);
  const page = join(workspace, PAGE);
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 };
  let turns = 0;
  let artifact: string | undefined;
  let firstRenderMs: number | undefined;
  let failure: string | undefined;
  let settledMs = 0;

  /** The page as it stands, when it has changed. A write is only on disk once
   *  the tool that made it has returned, so looking between events sees every
   *  revision and never half of one — the first is the first moment there was
   *  anything to paint, and the last is what the session delivered. */
  const observe = async (): Promise<void> => {
    const html = await readFile(page, "utf8").catch(() => undefined);
    if (html === undefined || html === artifact) return;
    firstRenderMs ??= meter.elapsedMs();
    artifact = html;
  };

  try {
    const session = (options.spawn ?? spawnCodex)(CODEX, invocation(workspace, modelId, brief(world, testCase)), {
      cwd: workspace,
      env: sessionEnv(home),
    });
    // The case's own budget, forwarded: a column whose case has already been
    // recorded is a session nobody is waiting for, and it holds a laptop's worth
    // of engine while the row moves on.
    request.signal?.addEventListener("abort", () => session.kill());
    const drain = (async () => {
      for await (const event of events(session.output)) {
        await observe();
        // Every turn's tokens as they land. A session killed at the wall clock
        // still burned them, and a column that reports $0.0000 for ten minutes
        // of engine is the cheapest on the board by having failed.
        if (event["type"] === "turn.completed") {
          record(usage, event["usage"]);
          turns += 1;
        }
        if (event["type"] === "turn.failed") failure = failureOf(event);
      }
    })();
    const finished = await Promise.race([
      drain.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), options.timeoutMs ?? WALL_CLOCK_MS).unref()),
    ]);
    if (!finished) {
      // The session is told to stop, and the run does not wait to see it happen:
      // a loop that already outran its budget is not one to hand the clock back
      // to. Its rejection is absorbed so it cannot surface as an unhandled one.
      session.kill();
      void drain.catch(() => undefined);
      failure = "timeout";
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    // Whatever is on disk when the session ends is what it delivered — a run
    // that timed out still delivered the last page it wrote.
    await observe();
    settledMs = meter.elapsedMs();
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }

  return {
    format: "html",
    ...(artifact === undefined ? {} : { artifact }),
    // Nothing stands between these bytes and the browser: no compile to fail, so
    // no finding the product's own floor could raise about them.
    blocking: [],
    snapshots: [],
    usage,
    usd: usdFor(usage, modelId),
    // How hard the session had to work, which is all it says about itself beyond
    // its tokens: the CLI reports no dollar figure of its own, so `billedUsd` is
    // absent rather than a zero that would read as a free session.
    session: { turns },
    ...(firstRenderMs === undefined ? {} : { firstRenderMs }),
    settledMs,
    ...(failure === undefined ? {} : { failure }),
  };
}
