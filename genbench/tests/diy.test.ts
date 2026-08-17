/**
 * The fairness assertion, for every contender.
 *
 * Every number this benchmark reports rests on one claim: each in-house
 * contender was handed EXACTLY what the product's own pipeline was handed. So
 * the bytes are compared. The design brief the vendo driver composes, the
 * descriptors its registry serves, and the responses that registry really
 * returns must all appear verbatim in the prompt EACH baseline sends. If any
 * side ever drifts — a reformatted brief, a hand-rolled schema dump, a
 * different canned response — this test fails and the comparison is void.
 *
 * The two baselines share one serializer (`worldBlock`) precisely so they
 * cannot drift apart, but a shared helper is not the assertion: the prompt
 * under test is the one each driver actually put on the wire, read off the
 * model `diy` streamed through and off the session `claude-code` opened. Only
 * the model and the SDK are doubles.
 */
import { renderBriefingPack } from "@vendoai/apps/contract";
import type { RunContext } from "@vendoai/core";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { claudeCodeDriver, type AgentSdk } from "../src/claude-code.js";
import { codexDriver, type CodexSpawn } from "../src/codex.js";
import { diyDriver, diySystemPrompt } from "../src/diy.js";
import type { Meter } from "../src/meter.js";
import { authoredPage, HARNESS_CONTRACT, openBrowser } from "../src/render.js";
import { worldBlock, worldBriefing, worldRegistry } from "../src/vendo.js";
import { cannedResponse, loadCases, loadWorld, worldForCase, type Case, type World } from "../src/world.js";

type Sent = Parameters<MockLanguageModelV3["doStream"]>[0]["prompt"];

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

const CTX: RunContext = {
  principal: { kind: "user", subject: "genbench" },
  venue: "chat",
  presence: "present",
  sessionId: "genbench_fairness",
};

const PAGE = `<!doctype html><html lang="en"><head><title>t</title></head><body><p>hi</p></body></html>`;

/** A meter over a model that answers with `text` in two deltas and keeps the
 *  prompt it was sent. Two deltas so the chunk loop is exercised, not skipped. */
function replying(text: string): { meter: Meter; sent: () => Sent } {
  let prompt: Sent = [];
  const half = Math.ceil(text.length / 2);
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompt = options.prompt;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: text.slice(0, half) },
            { type: "text-delta", id: "t", delta: text.slice(half) },
            { type: "text-end", id: "t" },
            { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
          ],
        }),
      };
    },
  });
  let tick = 0;
  return {
    meter: {
      model,
      elapsedMs: () => (tick += 1),
      totals: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 }),
      usd: () => 0,
      answeredBy: () => undefined,
    },
    sent: () => prompt,
  };
}

const systemOf = (prompt: Sent): string =>
  prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content as string)
    .join("\n");

const userOf = (prompt: Sent): string =>
  prompt
    .filter((message) => message.role === "user")
    .flatMap((message) => (message.content as Array<{ type: string; text?: string }>))
    .map((part) => part.text ?? "")
    .join("");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
let cases: readonly Case[];
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
  cases = await loadCases(join(root, "worlds", "maple", "cases.json"));
});

/** The prompt the diy driver really sent for this case's world. */
async function promptFor(scoped: World, testCase: Case): Promise<{ system: string; user: string }> {
  const { meter, sent } = replying(PAGE);
  await diyDriver().run({ world: scoped, testCase, meter });
  return { system: systemOf(sent()), user: userOf(sent()) };
}

/** The brief the claude-code driver really opened its session with. The double
 *  writes a page, because a session that delivers nothing is a different test. */
async function sessionBriefFor(scoped: World, testCase: Case): Promise<string> {
  let brief = "";
  const sdk: AgentSdk = {
    query({ prompt, options }) {
      brief = prompt;
      return {
        async *[Symbol.asyncIterator]() {
          await writeFile(join(options["cwd"] as string, "index.html"), PAGE);
          yield { type: "result", subtype: "success", usage: {}, total_cost_usd: 0 };
        },
      };
    },
  };
  await claudeCodeDriver({ sdk }).run({ world: scoped, testCase, meter: replying(PAGE).meter });
  return brief;
}

/** The brief the codex driver really spawned its CLI with — the last argument of
 *  the invocation, which is where `codex exec` takes its prompt. The double
 *  writes a page for the same reason the one above does. */
async function execBriefFor(scoped: World, testCase: Case): Promise<string> {
  let brief = "";
  const spawn: CodexSpawn = (_command, args, options) => {
    brief = args.at(-1)!;
    return {
      output: (async function* () {
        await writeFile(join(options.cwd, "index.html"), PAGE);
        yield `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`;
      })(),
      kill: () => undefined,
    };
  };
  await codexDriver({ model: "sol", spawn }).run({ world: scoped, testCase, meter: replying(PAGE).meter });
  return brief;
}

/** Every contender that is NOT the product, and the real prompt each one sent.
 *  The vendo column is the other side of every comparison below — it is what
 *  they are checked against, so it needs no row of its own. */
const BASELINES: ReadonlyArray<{ name: string; briefFor(scoped: World, testCase: Case): Promise<string> }> = [
  {
    name: "diy",
    // System and user together: what the contender was handed is the whole
    // call, and diy is the one that splits it in two.
    briefFor: async (scoped, testCase) => {
      const { system, user } = await promptFor(scoped, testCase);
      return `${system}\n${user}`;
    },
  },
  { name: "claude-code", briefFor: sessionBriefFor },
  { name: "codex", briefFor: execBriefFor },
];

describe.each(BASELINES)("$name is handed exactly what vendo is handed", ({ briefFor }) => {
  it("carries the product's own design brief verbatim — identity, theme JSON and style lines", async () => {
    const sent = await briefFor(world, cases[0]!);
    const brief = renderBriefingPack(worldBriefing(world));

    // Not a substring of a substring: the whole block, exactly as the vendo
    // driver hands it to the screen assembler.
    expect(brief).toContain(JSON.stringify(world.theme, null, 2));
    expect(brief).toContain(world.style[0]!);
    expect(sent).toContain(brief);
  });

  it("carries every descriptor the vendo registry serves, byte for byte", async () => {
    const sent = await briefFor(world, cases[0]!);
    const descriptors = await worldRegistry(world).descriptors();

    expect(descriptors.length).toBe(world.tools.length);
    for (const descriptor of descriptors) {
      expect(sent).toContain(JSON.stringify(descriptor, null, 2));
    }
  });

  it("carries the response that registry actually returns for each tool", async () => {
    const sent = await briefFor(world, cases[0]!);
    const registry = worldRegistry(world);

    for (const descriptor of await registry.descriptors()) {
      const outcome = await registry.execute({ id: "c1", tool: descriptor.name, args: {} }, CTX);
      expect(outcome.status).toBe("ok");
      expect(sent).toContain(JSON.stringify((outcome as { output: unknown }).output, null, 2));
    }
  });

  it("is scoped to the case, so an overridden world reaches it and the authored one does not", async () => {
    const empty = cases.find((entry) => entry.id === "no-pending-transfers")!;
    const sent = await briefFor(worldForCase(world, empty), empty);

    expect(sent).toContain(JSON.stringify({ data: [] }, null, 2));
    expect(sent).not.toContain("Alex Rivera");
  });

  it("carries the case's prompt, unchanged", async () => {
    expect(await briefFor(world, cases[0]!)).toContain(cases[0]!.prompt);
  });

  it("carries the shared harness contract, byte for byte", async () => {
    expect(await briefFor(world, cases[0]!)).toContain(HARNESS_CONTRACT);
  });
});

/**
 * The other half of the fairness assertion: not only that both baselines get the
 * same text, but that NEITHER gets any harness coaching outside it.
 *
 * Containment alone let the two drift and stay green. `claude-code` was told how
 * to wire `window.vendo`, that a confirmation needs `role="dialog"`, to set the
 * settle signal, and what size the shot is taken at — and `diy` was told none of
 * it, while its honesty line still recited a deterministic allowlist the floor had
 * already deleted. A column coached on the harness beside a column that was not is
 * a column graded on what it was told.
 *
 * So the diff is fenced: everything each baseline says that is NOT the world
 * block, NOT the shared contract and NOT the case prompt must be silent about the
 * seam. What is left over is each column's own delivery instruction — where its
 * page goes — and that is the only thing that may differ.
 */
describe("the harness contract is the ONLY place either baseline is coached on the harness", () => {
  /** Every way a page's mechanics can be named. A sentence about any of these,
   *  outside the shared block, is coaching one column and not the other. */
  const MECHANICS = [
    /window\.vendo/i,
    /callTool/i,
    /__settled/,
    /role\s*=\s*"?dialog/i,
    /\bdialog\b/i,
    /viewport/i,
    /480/,
    /\bnetwork\b/i,
    /\binline\b/i,
    /\bsum, count\b/i,
    /\ballowlist\b/i,
  ];

  /** What a baseline says on its own account: its brief minus the three blocks
   *  every column shares. */
  const ownWords = async (
    baseline: (typeof BASELINES)[number],
  ): Promise<string> =>
    (await baseline.briefFor(world, cases[0]!))
      .replace(worldBlock(world), " ")
      .replace(HARNESS_CONTRACT, " ")
      .replace(cases[0]!.prompt, " ");

  it("hands both baselines the identical contract, and it is identical to the one the harness pins", async () => {
    const briefs = await Promise.all(BASELINES.map(async (baseline) => await baseline.briefFor(world, cases[0]!)));

    for (const brief of briefs) {
      expect(brief).toContain(HARNESS_CONTRACT);
      // The contract is not a paraphrase of the seam, it is the seam: the size
      // it names is the size the shooter really uses.
      expect(HARNESS_CONTRACT).toContain("480x900");
    }
    // One text, one occurrence each — a second copy would mean two sources.
    for (const brief of briefs) expect(brief.split(HARNESS_CONTRACT)).toHaveLength(2);
  });

  it.each(BASELINES)("$name says nothing else about the harness at all", async (baseline) => {
    const own = await ownWords(baseline);

    expect(MECHANICS.filter((mechanic) => mechanic.test(own))).toEqual([]);
  });

  /** The fence has to be able to catch something, or it is a test that passes on
   *  an empty string. */
  it("catches a baseline that starts coaching the harness on its own again", async () => {
    const coached = `${await ownWords(BASELINES[0]!)}\nSet window.__settled = true when you are done.`;

    expect(MECHANICS.filter((mechanic) => mechanic.test(coached))).not.toEqual([]);
  });
});

describe("the diy prompt", () => {
  it("sends the case prompt as the user message, unchanged", async () => {
    const { user } = await promptFor(world, cases[0]!);
    expect(user).toBe(cases[0]!.prompt);
  });
});

describe("the page answers the way the prompt promised", () => {
  /** A SEAM test: the real injected recorder, in a real browser, called exactly
   *  the way the prompt tells the model to call it.
   *
   *  Regression, from a real run on 2026-08-08: the prompt said `callTool`
   *  "answers with the response shown under returns", and the recorder actually
   *  answers with that response wrapped in a `ToolOutcome`. The model believed
   *  the prompt, read `res.data`, got `undefined`, and rendered "No pending
   *  transfers right now" over a tool holding two of them. A prompt that lies
   *  about the seam does not measure the contender — it measures the lie. */
  it("wraps the canned response in the envelope the prompt describes, and answers synchronously", async () => {
    const shooter = await openBrowser();
    try {
      const visit = await shooter.visit(
        authoredPage(`<!doctype html><html lang="en"><head><title>t</title></head><body><p>x</p></body></html>`, world, "diy-sonnet"),
      );
      try {
        const answered = await visit.page.evaluate(() => {
          const returned = (
            window as unknown as { vendo: { callTool(name: string, args: unknown): unknown } }
          ).vendo.callTool("list_transfers", { limit: 20 });
          return {
            value: returned,
            // Decided INSIDE the page: `evaluate` unwraps a thenable before it
            // could ever reach an assertion out here, so asking the browser is
            // the only way to know whether a Promise was returned.
            thenable: typeof (returned as { then?: unknown } | null)?.then === "function",
          };
        });
        const transfers = world.tools.find((tool) => tool.name === "list_transfers")!;

        expect(answered.value).toEqual({ status: "ok", output: cannedResponse(transfers) });
        expect(answered.thenable).toBe(false);
        // …and the prompt says exactly that, so the model is not guessing at
        // either the envelope or whether it has to await the call.
        expect(diySystemPrompt(world)).toContain(`{ status: "ok", output:`);
        expect(diySystemPrompt(world)).toContain("RETURNS that object synchronously — it is not a Promise");
      } finally {
        await visit.close();
      }
    } finally {
      await shooter.close();
    }
  }, 120_000);
});

describe("the diy driver", () => {
  it("reports the document it was given as the page", async () => {
    const { meter } = replying(PAGE);
    const outcome = await diyDriver().run({ world, testCase: cases[0]!, meter });

    expect(outcome.artifact).toBe(PAGE);
    expect(outcome.failure).toBeUndefined();
  });

  /** The case's budget never reached the provider, so a column whose case had
   *  already been recorded went on generating — and went on billing — for a
   *  screen nobody was waiting for. */
  it("passes the case's budget through to the generation itself", async () => {
    const { meter } = replying(PAGE);
    const lost = new AbortController();
    await diyDriver().run({ world, testCase: cases[0]!, meter, signal: lost.signal });

    const model = meter.model as MockLanguageModelV3;
    expect(model.doStreamCalls[0]!.abortSignal).toBe(lost.signal);
  });

  it("takes the document out of a fenced answer", async () => {
    const { meter } = replying(`Here you go:\n\n\`\`\`html\n${PAGE}\n\`\`\`\n`);
    const outcome = await diyDriver().run({ world, testCase: cases[0]!, meter });

    expect(outcome.artifact).toBe(PAGE);
  });

  it("reports first paint at the settle, because a whole document is the unit", async () => {
    const { meter } = replying(PAGE);
    const outcome = await diyDriver().run({ world, testCase: cases[0]!, meter });

    expect(outcome.firstRenderMs).toBe(outcome.settledMs);
    // One entry per chunk boundary: the stream's shape is the evidence that the
    // whole wait was one silence.
    expect(outcome.snapshots.length).toBe(2);
  });

  it("fails honestly when the model answers without a document", async () => {
    const { meter } = replying("I can't help with that.");
    const outcome = await diyDriver().run({ world, testCase: cases[0]!, meter });

    expect(outcome.artifact).toBeUndefined();
    expect(outcome.failure).toBeDefined();
  });
});
