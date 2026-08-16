/**
 * The claude-code contender, with everything real except the SDK.
 *
 * The double is the SDK boundary and nothing else: it writes into the workspace
 * the driver actually made, on disk, so the file-watching, the snapshots and the
 * cleanup are the driver's own behaviour and not a fixture's.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { renderBriefingPack } from "@vendoai/apps/contract";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { claudeCodeDriver, type AgentSdk } from "../src/claude-code.js";
import { meteredModel, MODEL_IDS, usdFor, type Meter } from "../src/meter.js";
import { worldBlock, worldBriefing } from "../src/vendo.js";
import { cannedResponse, loadCases, loadWorld, worldForCase, type Case, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
});

const caseFor = (id: string): Case => ({ id, lane: "screen", prompt: "Show my pending transfers", pass: [], shape: "table" });

/** The run's clock, and nothing else the driver may lean on: this contender is
 *  billed by the SDK's own session, so a meter it actually used would be a lie. */
function clock(): Meter {
  let tick = 0;
  return {
    model: "claude-sonnet-5",
    elapsedMs: () => (tick += 1),
    totals: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 }),
    usd: () => 0,
    answeredBy: () => undefined,
  };
}

const SDK_USAGE = {
  input_tokens: 1_200,
  output_tokens: 8_400,
  cache_read_input_tokens: 5_000,
  cache_creation_input_tokens: 900,
} as const;

interface Seen {
  prompt?: string;
  options?: Record<string, unknown>;
}

/** A session that writes each revision in turn and then finishes, exactly as the
 *  real one does: one message per write, one `result` at the end. */
function writingSdk(revisions: readonly string[], seen: Seen, subtype = "success"): AgentSdk {
  return {
    query({ prompt, options }) {
      seen.prompt = prompt;
      seen.options = options;
      return {
        async *[Symbol.asyncIterator]() {
          for (const html of revisions) {
            await writeFile(join(options["cwd"] as string, "index.html"), html);
            yield { type: "user", message: { content: [{ type: "tool_result" }] } };
          }
          yield { type: "result", subtype, usage: SDK_USAGE, total_cost_usd: 0.0421, num_turns: revisions.length };
        },
      };
    },
  };
}

/** A session that never answers — the shape a wall-clock bound exists for. It
 *  burns `turns` turns of real tokens first, because that is what a real one
 *  does before it runs out of clock. */
function hangingSdk(seen: Seen, turns = 0): AgentSdk {
  return {
    query({ options }) {
      seen.options = options;
      return {
        async *[Symbol.asyncIterator]() {
          for (let turn = 0; turn < turns; turn += 1) {
            yield { type: "assistant", message: { usage: SDK_USAGE } };
          }
          await new Promise<void>(() => undefined);
          yield {};
        },
      };
    },
  };
}

const workspaceOf = (seen: Seen): string => seen.options!["cwd"] as string;

describe("the world block", () => {
  it("is the product's own design brief, byte for byte", async () => {
    const brief = renderBriefingPack(worldBriefing(world));

    // Not a vacuous containment: the brief carries the theme the screen agent is
    // handed and the host's own rules, or the two contenders are told different
    // things about the same world.
    expect(brief).toContain("THEME TOKENS:");
    expect(brief).toContain("Maple, a consumer banking app");
    expect(worldBlock(world)).toContain(brief);
  });

  it("carries every derived tool schema and the response it answers with", () => {
    const block = worldBlock(world);

    expect(world.tools.length).toBeGreaterThan(0);
    for (const tool of world.tools) {
      // `cannedResponse`, not `tool.data`: a write returns a bare
      // acknowledgement, and the session must be told the same thing the
      // registry and the injected recorder actually answer with.
      expect(block).toContain(JSON.stringify(tool.descriptor, null, 2));
      expect(block).toContain(`returns: ${JSON.stringify(cannedResponse(tool), null, 2)}`);
    }
  });
});

describe("driving Claude Code", () => {
  /**
   * The column is STOCK Claude Code, which is the whole reason it is the strong
   * baseline: a team that installs it gets Bash and everything else in the box.
   * Restricting it to Read/Write/Edit measured a loadout nobody ships.
   *
   * What stays is isolation, not capability — the operator's own settings, the
   * operator's MCP config and the operator's environment, all of which would
   * silently become this column's advantage or its handicap.
   */
  it("hands the session the world block, the case's prompt and the stock loadout", async () => {
    const seen: Seen = {};
    await claudeCodeDriver({ sdk: writingSdk(["<html></html>"], seen) }).run({
      world,
      testCase: caseFor("pending-transfers"),
      meter: clock(),
    });

    expect(seen.prompt).toContain(worldBlock(world));
    expect(seen.prompt).toContain("Show my pending transfers");
    expect(seen.options).toMatchObject({
      cwd: expect.any(String),
      model: MODEL_IDS.sonnet,
      permissionMode: "bypassPermissions",
      settingSources: [],
      strictMcpConfig: true,
    });
    // No availability list at all: the session brings its own.
    expect(seen.options).not.toHaveProperty("tools");
  });

  it("spells the subprocess environment out rather than handing over the operator's shell", async () => {
    const seen: Seen = {};
    process.env["ANTHROPIC_BASE_URL"] = "https://a-gateway-nobody-declared.example";
    try {
      await claudeCodeDriver({ sdk: writingSdk(["<html></html>"], seen) }).run({
        world,
        testCase: caseFor("pending-transfers"),
        meter: clock(),
      });
    } finally {
      delete process.env["ANTHROPIC_BASE_URL"];
    }

    // The SDK inherits `process.env` wholesale, so a stray gateway, model or
    // CLAUDE_CODE_* left in a shell reshapes this column and nothing says so.
    const env = seen.options!["env"] as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "HOME", "PATH"].filter((name) => name in env));
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
  });

  it("snapshots every write of index.html, in order, on the run's clock", async () => {
    const seen: Seen = {};
    const outcome = await claudeCodeDriver({ sdk: writingSdk(["<p>one</p>", "<p>two</p>", "<p>three</p>"], seen) }).run({
      world,
      testCase: caseFor("pending-transfers"),
      meter: clock(),
    });

    expect(outcome.writes.map((write) => write.html)).toEqual(["<p>one</p>", "<p>two</p>", "<p>three</p>"]);
    const times = outcome.writes.map((write) => write.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(outcome.artifact).toBe("<p>three</p>");
    expect(outcome.firstRenderMs).toBe(times[0]);
    expect(outcome.settledMs).toBeGreaterThanOrEqual(times.at(-1)!);
    expect(outcome.failure).toBeUndefined();
    expect(existsSync(workspaceOf(seen))).toBe(false);
  });

  it("reports the SDK's own tokens, priced from genbench's one table", async () => {
    const outcome = await claudeCodeDriver({ model: "opus", sdk: writingSdk(["<p>done</p>"], {}) }).run({
      world,
      testCase: caseFor("pending-transfers"),
      meter: clock(),
    });

    const usage = { inputTokens: 1_200, outputTokens: 8_400, cacheReadTokens: 5_000, cacheWriteTokens: 900, calls: 1 };
    expect(outcome.usage).toEqual(usage);
    expect(outcome.usd).toBe(usdFor(usage, MODEL_IDS.opus));
  });

  it("reports a session that ended badly as a failure, with whatever it wrote", async () => {
    const outcome = await claudeCodeDriver({
      sdk: writingSdk(["<p>half</p>"], {}, "error_max_turns"),
    }).run({ world, testCase: caseFor("pending-transfers"), meter: clock() });

    expect(outcome.artifact).toBe("<p>half</p>");
    expect(outcome.failure).toBe("error_max_turns");
  });

  it("gives back a timeout instead of throwing when the session outruns its budget", async () => {
    const seen: Seen = {};
    const outcome = await claudeCodeDriver({ sdk: hangingSdk(seen), timeoutMs: 50 }).run({
      world,
      testCase: caseFor("pending-transfers"),
      meter: clock(),
    });

    expect(outcome.failure).toBe("timeout");
    expect(outcome.artifact).toBeUndefined();
    expect(outcome.writes).toEqual([]);
    // A workspace left behind by the one path that does not finish is the leak
    // nobody would notice until a laptop ran out of disk.
    expect(existsSync(workspaceOf(seen))).toBe(false);
  });

  /**
   * Usage was read off the `result` message alone — and a session that outruns
   * its clock never sends one. So a column that burned ten minutes of engine
   * published $0.0000 and 0 tokens, which is not a small error: it is the
   * cheapest column on the board, by having failed.
   */
  it("reports the tokens a timed-out session really burned, not zero", async () => {
    const seen: Seen = {};
    const outcome = await claudeCodeDriver({ sdk: hangingSdk(seen, 3), timeoutMs: 50 }).run({
      world,
      testCase: caseFor("pending-transfers"),
      meter: clock(),
    });

    expect(outcome.failure).toBe("timeout");
    expect(outcome.usage).toEqual({
      inputTokens: 3 * SDK_USAGE.input_tokens,
      outputTokens: 3 * SDK_USAGE.output_tokens,
      cacheReadTokens: 3 * SDK_USAGE.cache_read_input_tokens,
      cacheWriteTokens: 3 * SDK_USAGE.cache_creation_input_tokens,
      calls: 3,
    });
    expect(outcome.usd).toBeGreaterThan(0);
  });

  /** …and a session that DID finish reports its own totals, not the turns added
   *  up beside them: the `result` message is the SDK's own accounting and it
   *  supersedes the stand-in rather than doubling it. */
  it("takes a finished session's own totals over the turn-by-turn stand-in", async () => {
    const sdk: AgentSdk = {
      query({ options }) {
        return {
          async *[Symbol.asyncIterator]() {
            await writeFile(join(options["cwd"] as string, "index.html"), "<p>done</p>");
            yield { type: "assistant", message: { usage: SDK_USAGE } };
            yield { type: "assistant", message: { usage: SDK_USAGE } };
            yield {
              type: "result",
              subtype: "success",
              usage: SDK_USAGE,
              total_cost_usd: 0.0421,
              num_turns: 2,
              modelUsage: { "claude-sonnet-5": { inputTokens: 1_200 } },
            };
          },
        };
      },
    };

    const outcome = await claudeCodeDriver({ sdk }).run({
      world,
      testCase: caseFor("pending-transfers"),
      meter: clock(),
    });

    expect(outcome.usage).toEqual({ inputTokens: 1_200, outputTokens: 8_400, cacheReadTokens: 5_000, cacheWriteTokens: 900, calls: 1 });
    // How hard it had to work, and what the engine says it charged — both were
    // read off the result message and thrown away, the price gap into a
    // `console.warn` nobody keeps.
    expect(outcome.session).toEqual({
      turns: 2,
      modelUsage: { "claude-sonnet-5": { inputTokens: 1_200 } },
      billedUsd: 0.0421,
    });
  });

  /** The case's budget is the outer one, and it never reached the driver: a
   *  column whose case had already been recorded kept a whole engine running,
   *  for a screen nobody was waiting for. */
  it("stops the session when the case's own budget is spent", async () => {
    const seen: Seen = {};
    const lost = new AbortController();
    const running = claudeCodeDriver({ sdk: hangingSdk(seen), timeoutMs: 200 }).run({
      world,
      testCase: caseFor("pending-transfers"),
      meter: clock(),
      signal: lost.signal,
    });
    await vi.waitFor(() => expect(seen.options).toBeDefined());

    lost.abort();
    expect((seen.options!["abortController"] as AbortController).signal.aborted).toBe(true);
    await running;
  });
});

/** ONE live session, off unless asked for. Every double above answers the
 *  question "does the driver read a session correctly"; only this one answers
 *  "are these the options a real engine accepts", which no fixture can. */
const LIVE = process.env.GENBENCH_LIVE === "1" && (process.env.ANTHROPIC_API_KEY ?? "") !== "";

describe.skipIf(!LIVE)("one live session", () => {
  it(
    "builds a real page for a real case, and says what it cost",
    async () => {
      const testCase = (await loadCases(join(root, "worlds", "maple", "cases.json"))).find(
        (entry) => entry.id === "pending-transfers",
      )!;
      const modelId = MODEL_IDS.sonnet;
      const meter = meteredModel(createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })(modelId), modelId);

      const outcome = await claudeCodeDriver({ model: "sonnet" }).run({
        world: worldForCase(world, testCase),
        testCase,
        meter,
      });

      const { usage } = outcome;
      const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      console.log(
        `live claude-code · ${outcome.settledMs} ms · ${outcome.writes.length} writes · ` +
          `${tokens.toLocaleString("en-US")} tokens · $${outcome.usd.toFixed(4)} · ${outcome.artifact?.length ?? 0} bytes`,
      );
      expect(outcome.failure).toBeUndefined();
      // The two seams the page is measured through, in the bytes it left behind.
      expect(outcome.artifact).toContain("__settled");
      expect(outcome.artifact).toContain("callTool");
    },
    12 * 60_000,
  );
});
