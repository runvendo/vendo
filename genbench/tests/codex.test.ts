/**
 * The codex contender, with everything real except the process.
 *
 * The double is the spawn boundary and nothing else: it writes into the
 * workspace the driver actually made, on disk, and answers in the CLI's own
 * JSONL, so the line parsing, the file watching, the accounting and the cleanup
 * are the driver's own behaviour and not a fixture's.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { codexDriver, type CodexSpawn } from "../src/codex.js";
import { MODEL_IDS, usdFor, type Meter, type UsageTotals } from "../src/meter.js";
import type { RunOutcome } from "../src/run.js";
import { worldBlock } from "../src/vendo.js";
import { loadCases, loadWorld, worldForCase, type Case, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
});

const caseFor = (id: string): Case => ({ id, lane: "screen", prompt: "Show my pending transfers", pass: [], shape: "table" });

/** The run's clock, and nothing else the driver may lean on: this contender is
 *  billed by its own session, so a meter it actually used would be a lie. */
function clock(): Meter {
  let tick = 0;
  return {
    model: MODEL_IDS.sol,
    elapsedMs: () => (tick += 1),
    totals: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 }),
    usd: () => 0,
    answeredBy: () => undefined,
  };
}

/** One completed turn as the CLI reports it. `input_tokens` includes both cache
 *  halves and `reasoning_output_tokens` is part of `output_tokens`, which is why
 *  neither number is the one the report prices. */
const TURN_USAGE = {
  input_tokens: 12_000,
  cached_input_tokens: 5_000,
  cache_write_input_tokens: 900,
  output_tokens: 8_400,
  reasoning_output_tokens: 6_000,
} as const;

/** What the report bills for `turns` of {@link TURN_USAGE}: the full input rate
 *  applies to what is left once both cache halves are taken out, and the
 *  reasoning tokens are already inside the output count. */
const billed = (turns: number): UsageTotals => ({
  inputTokens: turns * (12_000 - 5_000 - 900),
  outputTokens: turns * 8_400,
  cacheReadTokens: turns * 5_000,
  cacheWriteTokens: turns * 900,
  calls: turns,
});

interface Seen {
  command?: string;
  args?: readonly string[];
  options?: { cwd: string; env: Record<string, string> };
  killed?: boolean;
}

const line = (event: Record<string, unknown>): string => `${JSON.stringify(event)}\n`;

/** A session that writes each revision in turn and then completes, as the real
 *  one does: the CLI's own events, one JSON object per line. */
function writingCodex(revisions: readonly string[], seen: Seen, ending?: Record<string, unknown>): CodexSpawn {
  return (command, args, options) => {
    Object.assign(seen, { command, args, options });
    return {
      output: (async function* () {
        yield line({ type: "thread.started", thread_id: "t1" });
        for (const html of revisions) {
          await writeFile(join(options.cwd, "index.html"), html);
          yield line({ type: "item.completed", item: { type: "file_change" } });
        }
        yield line(ending ?? { type: "turn.completed", usage: TURN_USAGE });
      })(),
      kill: () => {
        seen.killed = true;
      },
    };
  };
}

/** A session that never ends — the shape a wall-clock bound exists for. It
 *  writes and bills first, because that is what a real one does before it runs
 *  out of clock. */
function hangingCodex(seen: Seen, turns = 0, revisions: readonly string[] = []): CodexSpawn {
  return (command, args, options) => {
    Object.assign(seen, { command, args, options });
    return {
      output: (async function* () {
        for (const html of revisions) {
          await writeFile(join(options.cwd, "index.html"), html);
          yield line({ type: "item.completed", item: { type: "file_change" } });
        }
        for (let turn = 0; turn < turns; turn += 1) yield line({ type: "turn.completed", usage: TURN_USAGE });
        await new Promise<void>(() => undefined);
      })(),
      kill: () => {
        seen.killed = true;
      },
    };
  };
}

const runCase = async (spawn: CodexSpawn, timeoutMs?: number): Promise<RunOutcome> =>
  await codexDriver({ model: "sol", spawn, ...(timeoutMs === undefined ? {} : { timeoutMs }) }).run({
    world,
    testCase: caseFor("pending-transfers"),
    meter: clock(),
  });

describe("driving Codex", () => {
  /**
   * The column is STOCK `codex exec`, for the same reason `claude-code` is stock
   * Claude Code: the baseline this column stands for is the one a team actually
   * installs. What stays is isolation — the operator's own config, plugins, MCP
   * servers and environment, all of which would silently become this column's
   * advantage or its handicap.
   */
  it("runs the pinned binary with the world block, the case's prompt and the stock loadout", async () => {
    const seen: Seen = {};
    await runCase(writingCodex(["<html></html>"], seen));

    // The declared devDependency's own binary, on disk, rather than whatever
    // `codex` the operator's shell would have found.
    expect(seen.command!.endsWith(join("node_modules", ".bin", "codex"))).toBe(true);
    expect(existsSync(seen.command!)).toBe(true);
    // The whole invocation, exactly: an added flag is a different loadout, and
    // there is no approval flag because `codex exec` never asks and rejects one.
    expect(seen.args!.slice(0, -1)).toEqual([
      "exec",
      "--cd",
      seen.options!.cwd,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--json",
      "-c",
      // The sandbox turns the network off, and `claude-code` runs with stock
      // Bash — a column that cannot fetch is a column handicapped by its wrapper.
      "sandbox_workspace_write.network_access=true",
      "-m",
      MODEL_IDS.sol,
    ]);
    expect(seen.args!.at(-1)).toContain(worldBlock(world));
    expect(seen.args!.at(-1)).toContain("Show my pending transfers");
  });

  /** The allowlist, and the one rename in it. A live `OPENAI_API_KEY` is a key
   *  0.147.0 never reads: with a fresh home it sends no `Authorization` header
   *  at all, and the column's first call died on `401 … Missing bearer` for a
   *  session that was holding a working key the whole time. */
  it("spells the subprocess environment out, with the key under the name the CLI reads", async () => {
    const seen: Seen = {};
    const held = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-not-a-key";
    process.env["OPENAI_BASE_URL"] = "https://a-gateway-nobody-declared.example";
    try {
      await runCase(writingCodex(["<html></html>"], seen));
    } finally {
      if (held === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = held;
      delete process.env["OPENAI_BASE_URL"];
    }

    const env = seen.options!.env;
    expect(Object.keys(env).sort()).toEqual(["CODEX_API_KEY", "CODEX_HOME", "HOME", "PATH"].filter((name) => name in env));
    expect(env["CODEX_API_KEY"]).toBe("sk-not-a-key");
    // The name that reaches the CLI is the only one that authenticates, and the
    // operator's shell reaches it through neither.
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
    expect(env["OPENAI_BASE_URL"]).toBeUndefined();
  });

  /** The operator's own `~/.codex` holds private plugins, MCP servers and state
   *  files that take locks — so every session gets a home of its own, beside the
   *  workspace rather than inside it, and it does not outlive the case. */
  it("gives the session a throwaway home outside the workspace, and takes it away after", async () => {
    const seen: Seen = {};
    await runCase(writingCodex(["<html></html>"], seen));

    const home = seen.options!.env["CODEX_HOME"]!;
    expect(home.startsWith(seen.options!.cwd)).toBe(false);
    expect(existsSync(home)).toBe(false);
  });

  it("reports the last page written as the artifact, on the run's clock", async () => {
    const seen: Seen = {};
    const outcome = await runCase(writingCodex(["<p>one</p>", "<p>two</p>", "<p>three</p>"], seen));

    expect(outcome.artifact).toBe("<p>three</p>");
    expect(outcome.format).toBe("html");
    // The first page on disk is the first moment there was anything to paint,
    // and it is earlier than the settle because the session went on revising.
    expect(outcome.firstRenderMs).toBeLessThan(outcome.settledMs);
    expect(outcome.failure).toBeUndefined();
    expect(existsSync(seen.options!.cwd)).toBe(false);
  });

  /** Every turn's tokens, from a stream that does not land on line boundaries —
   *  a half-read line dropped is a whole turn nobody was billed for. */
  it("adds up every completed turn's tokens, priced from genbench's one table", async () => {
    const seen: Seen = {};
    const twoTurns: CodexSpawn = (command, args, options) => {
      Object.assign(seen, { command, args, options });
      const both = line({ type: "turn.completed", usage: TURN_USAGE }).repeat(2);
      return {
        output: (async function* () {
          await writeFile(join(options.cwd, "index.html"), "<p>done</p>");
          yield both.slice(0, 40);
          yield both.slice(40);
        })(),
        kill: () => undefined,
      };
    };
    const outcome = await runCase(twoTurns);

    expect(outcome.usage).toEqual(billed(2));
    expect(outcome.usd).toBe(usdFor(outcome.usage!, MODEL_IDS.sol));
    // How hard an agentic column had to work is the only thing the session says
    // about itself beyond its tokens, and the CLI names no price of its own.
    expect(outcome.session).toEqual({ turns: 2 });
  });

  /** stdout is not obliged to end on a newline, and the last line a session
   *  writes is the one carrying its tokens: held back and never flushed, a whole
   *  finished session bills at zero. */
  it("bills a final event that arrives without a newline after it", async () => {
    const unterminated: CodexSpawn = (_command, _args, options) => ({
      output: (async function* () {
        await writeFile(join(options.cwd, "index.html"), "<p>done</p>");
        yield JSON.stringify({ type: "turn.completed", usage: TURN_USAGE });
      })(),
      kill: () => undefined,
    });
    const outcome = await runCase(unterminated);

    expect(outcome.usage).toEqual(billed(1));
    expect(outcome.session).toEqual({ turns: 1 });
    expect(outcome.artifact).toBe("<p>done</p>");
  });

  /** The other half of that flush: what a killed process leaves at the end of
   *  stdout is half a line, and parsing it throws. Swallowed, or the session's
   *  own failure sentence is replaced by a JSON error about a line nobody
   *  needed. */
  it("swallows the half line a killed process leaves behind", async () => {
    const cut: CodexSpawn = (_command, _args, options) => ({
      output: (async function* () {
        await writeFile(join(options.cwd, "index.html"), "<p>half</p>");
        yield line({ type: "turn.completed", usage: TURN_USAGE });
        yield '{"type":"item.completed","item":{"id":"item_1"';
      })(),
      kill: () => undefined,
    });
    const outcome = await runCase(cut);

    expect(outcome.failure).toBeUndefined();
    expect(outcome.usage).toEqual(billed(1));
    expect(outcome.artifact).toBe("<p>half</p>");
  });

  it("reports a session that ended badly as a failure, with whatever it wrote", async () => {
    const outcome = await runCase(
      writingCodex(["<p>half</p>"], {}, { type: "turn.failed", error: { message: "context window exhausted" } }),
    );

    expect(outcome.artifact).toBe("<p>half</p>");
    expect(outcome.failure).toBe("context window exhausted");
  });

  it("kills the session and keeps its last page when it outruns its budget", async () => {
    const seen: Seen = {};
    const outcome = await runCase(hangingCodex(seen, 0, ["<p>half</p>"]), 50);

    expect(outcome.failure).toBe("timeout");
    expect(outcome.artifact).toBe("<p>half</p>");
    expect(seen.killed).toBe(true);
    // A workspace left behind by the one path that does not finish is the leak
    // nobody would notice until a laptop ran out of disk.
    expect(existsSync(seen.options!.cwd)).toBe(false);
    expect(existsSync(seen.options!.env["CODEX_HOME"]!)).toBe(false);
  });

  /** A session that outruns its clock never reports a total, and a column that
   *  burned ten minutes of engine for $0.0000 is the cheapest on the board by
   *  having failed. */
  it("reports the tokens a timed-out session really burned, not zero", async () => {
    const outcome = await runCase(hangingCodex({}, 3), 50);

    expect(outcome.failure).toBe("timeout");
    expect(outcome.usage).toEqual(billed(3));
    expect(outcome.usd).toBeGreaterThan(0);
  });

  /** The case's budget is the outer one: a column whose case has already been
   *  recorded keeps a whole engine running for a screen nobody is waiting for. */
  it("stops the session when the case's own budget is spent", async () => {
    const seen: Seen = {};
    const lost = new AbortController();
    const running = codexDriver({ model: "sol", spawn: hangingCodex(seen), timeoutMs: 200 }).run({
      world,
      testCase: caseFor("pending-transfers"),
      meter: clock(),
      signal: lost.signal,
    });
    await vi.waitFor(() => expect(seen.options).toBeDefined());

    lost.abort();
    expect(seen.killed).toBe(true);
    await running;
  });
});

/** ONE live session, off unless asked for. Every double above answers the
 *  question "does the driver read a session correctly"; only this one answers
 *  "is this an invocation the real CLI accepts", which no fixture can. */
const LIVE = process.env.GENBENCH_LIVE === "1" && (process.env.OPENAI_API_KEY ?? "") !== "";

describe.skipIf(!LIVE)("one live session", () => {
  it(
    "builds a real page for a real case, and says what it cost",
    async () => {
      const testCase = (await loadCases(join(root, "worlds", "maple", "cases.json"))).find(
        (entry) => entry.id === "pending-transfers",
      )!;
      const startedAt = performance.now();
      const meter: Meter = { ...clock(), elapsedMs: () => Math.round(performance.now() - startedAt) };

      const outcome = await codexDriver({ model: "sol" }).run({
        world: worldForCase(world, testCase),
        testCase,
        meter,
      });

      const usage = outcome.usage!;
      const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      console.log(
        `live codex · ${outcome.settledMs} ms · ${outcome.session?.turns ?? 0} turns · ` +
          `${tokens.toLocaleString("en-US")} tokens · $${(outcome.usd ?? 0).toFixed(4)} · ${outcome.artifact?.length ?? 0} bytes`,
      );
      expect(outcome.failure).toBeUndefined();
      // A turn that completed is a session that authenticated: a key the CLI
      // does not read ends the run with `turn.failed`, no turns and no tokens.
      expect(outcome.session?.turns).toBeGreaterThan(0);
      // The seam the page is measured through, in the bytes it left behind.
      // Only this one: the shared contract asks the page to CALL the recorder,
      // and says the harness decides when the screen has settled — so a page
      // that never mentions `__settled` is obeying it, not failing it.
      expect(outcome.artifact).toContain("callTool");
    },
    12 * 60_000,
  );
});
