/**
 * The claude-code contender — the strong in-house baseline: a coding agent with
 * hands, working in a scratch directory, writing and rewriting one page. It is
 * handed the SAME world every other column gets — the briefing pack for the
 * theme and the host's rules, the derived tool schemas, the rows each read
 * answers with — and the same harness contract the other page-writing column
 * gets, in the same bytes.
 *
 * It is billed by its OWN session, not by genbench's metered model: the SDK
 * spawns its own engine and never touches `meter.model`. So the tokens ride the
 * outcome instead, priced through the same `usdFor` table as every other
 * column. The meter is still the run's clock, and the only one.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_IDS, usdFor, type ModelAlias, type UsageTotals } from "./meter.js";
import { HARNESS_CONTRACT } from "./render.js";
import type { Contender, RunOutcome, RunRequest } from "./run.js";
import { worldBlock } from "./vendo.js";
import type { Case, World } from "./world.js";

/** The bits of the Agent SDK this driver uses. Narrow on purpose, exactly as
 *  `packages/harnesses/src/claude-code/claude-turn.ts` keeps it: the real
 *  message union has ~40 members and this loop branches on one. */
export interface AgentSdk {
  query(params: {
    prompt: string;
    options: Record<string, unknown>;
  }): AsyncIterable<Record<string, unknown>>;
}

export interface ClaudeCodeOptions {
  /** Which model the session thinks with. The run's matrix picks it. */
  readonly model?: ModelAlias;
  /** Test seam — production loads the Agent SDK from the declared dependency. */
  readonly sdk?: AgentSdk;
  /** Test seam; production uses {@link WALL_CLOCK_MS}. */
  readonly timeoutMs?: number;
}

export interface ClaudeCodeOutcome extends RunOutcome {
  /** The artifact IS the page: no compile, no payload, no Kit (`render.ts`). */
  readonly format: "html";
  /** One per observed write of `index.html`, oldest first, on the run's clock.
   *  `RunOutcome.snapshots` cannot carry these — it is typed to the product's
   *  compiled `UIPayload`, which this contender never produces. */
  readonly writes: ReadonlyArray<{ atMs: number; html: string }>;
  /** What the SDK's own session spent, and that spend at genbench's prices. */
  readonly usage: UsageTotals;
  readonly usd: number;
}

/** Agentic builds are slower than one generation call — a wall clock, not a
 *  step count. Exported because this column's case budget in `run.ts` has to
 *  outlast it: a case that ends first would report a timeout the contender
 *  never had. */
export const WALL_CLOCK_MS = 10 * 60_000;

const PAGE = "index.html";

/** Where this contender leaves its page, and nothing else. Everything the page
 *  itself has to satisfy is the shared `HARNESS_CONTRACT` — the same bytes `diy`
 *  is handed, because a column coached on the harness while its rival is not is a
 *  column graded on what it was told. The Vendo column needs neither: the
 *  product wires `window.vendo.callTool` and `window.__settled` for it in
 *  `mount.tsx` and applies the theme itself. */
const DELIVERY = `Write ONE file, \`${PAGE}\`, in the current directory. Nothing else is read.`;

const brief = (world: World, testCase: Case): string =>
  [worldBlock(world), "", DELIVERY, "", HARNESS_CONTRACT, "", `TASK: ${testCase.prompt}`].join("\n");

function sessionOptions(workspace: string, modelId: string, abort: AbortController): Record<string, unknown> {
  return {
    cwd: workspace,
    model: modelId,
    abortController: abort,
    // The contender IS Claude Code, so it thinks with Claude Code's own system
    // prompt. Only the loadout below is ours.
    systemPrompt: { type: "preset", preset: "claude_code" },
    // `tools` is the availability list; `allowedTools` would only auto-approve
    // what is already there. One file in a scratch directory needs no shell and
    // no network, and nothing here can ask a person anything.
    tools: ["Read", "Write", "Edit"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // The operator's own CLAUDE.md, settings, skills and any `.mcp.json` the
    // session writes itself stay out: a laptop's private tooling would silently
    // become this column's advantage.
    settingSources: [],
    strictMcpConfig: true,
  };
}

/** By dynamic import, so a run of the Vendo column alone never loads the SDK's
 *  ~250MB platform binary. */
async function loadAgentSdk(): Promise<AgentSdk> {
  return (await import("@anthropic-ai/claude-agent-sdk")) as unknown as AgentSdk;
}

const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The SDK's own `usage` block in the vocabulary the report already speaks. Its
 *  `input_tokens` excludes both cache halves, exactly as the meter's `noCache`
 *  does, so both columns price the same fact. `calls` counts the SDK's turns —
 *  the model calls inside one are the engine's business and are not reported. */
function record(totals: Record<keyof UsageTotals, number>, raw: unknown): void {
  const usage = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  totals.inputTokens += numberOf(usage["input_tokens"]);
  totals.outputTokens += numberOf(usage["output_tokens"]);
  totals.cacheReadTokens += numberOf(usage["cache_read_input_tokens"]);
  totals.cacheWriteTokens += numberOf(usage["cache_creation_input_tokens"]);
  totals.calls += 1;
}

/** A `Contender` whose outcome is the wider one: `run.ts` reads it through the
 *  base interface, and the wiring that gives this column its tokens and its page
 *  reads the rest. */
export interface ClaudeCodeContender extends Contender {
  run(request: RunRequest): Promise<ClaudeCodeOutcome>;
}

export function claudeCodeDriver(options: ClaudeCodeOptions = {}): ClaudeCodeContender {
  return { run: async (request) => await run(request, options) };
}

async function run(request: RunRequest, options: ClaudeCodeOptions): Promise<ClaudeCodeOutcome> {
  const { world, testCase, meter } = request;
  const modelId = MODEL_IDS[options.model ?? "sonnet"];
  const workspace = await mkdtemp(join(tmpdir(), `genbench-${testCase.id}-`));
  const page = join(workspace, PAGE);
  const writes: Array<{ atMs: number; html: string }> = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 };
  let billed = 0;
  let failure: string | undefined;
  let settledMs = 0;

  /** The page as it stands, when it has changed. A write is only on disk once
   *  the tool that made it has returned, so looking between messages sees every
   *  revision and never half of one. */
  const observe = async (): Promise<void> => {
    const html = await readFile(page, "utf8").catch(() => undefined);
    if (html === undefined || html === writes.at(-1)?.html) return;
    writes.push({ atMs: meter.elapsedMs(), html });
  };

  const abort = new AbortController();
  try {
    const sdk = options.sdk ?? (await loadAgentSdk());
    const drain = (async () => {
      const messages = sdk.query({
        prompt: brief(world, testCase),
        options: sessionOptions(workspace, modelId, abort),
      });
      for await (const message of messages) {
        await observe();
        if (message["type"] !== "result") continue;
        record(usage, message["usage"]);
        billed += numberOf(message["total_cost_usd"]);
        // The SDK's own word for how it ended, kept verbatim: `error_max_turns`
        // and a crash are different failures and the report should say which.
        if (message["subtype"] !== "success") failure = String(message["subtype"]);
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
      abort.abort();
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
  }

  const usd = usdFor(usage, modelId);
  // Two prices for one session is a measurement problem, not a driver bug. The
  // shared table wins, because that is what makes the columns comparable — but
  // a real gap is said out loud rather than quietly averaged away.
  if (billed > 0 && Math.abs(billed - usd) > Math.max(billed, usd) * 0.05) {
    console.warn(`  claude-code: the SDK billed $${billed.toFixed(4)}, priced here at $${usd.toFixed(4)}`);
  }

  const first = writes[0];
  const last = writes.at(-1);
  return {
    format: "html",
    ...(last === undefined ? {} : { artifact: last.html }),
    // Nothing stands between these bytes and the browser: no compile to fail, so
    // no finding the product's own floor could raise about them.
    blocking: [],
    snapshots: [],
    writes,
    usage,
    usd,
    // The first page on disk is the first moment there was anything to paint.
    ...(first === undefined ? {} : { firstRenderMs: first.atMs }),
    settledMs,
    ...(failure === undefined ? {} : { failure }),
  };
}
