/**
 * The fairness assertion.
 *
 * Every number this benchmark reports rests on one claim: the in-house
 * contender was handed EXACTLY what the product's own pipeline was handed. So
 * the bytes are compared. The design brief the vendo driver composes, the
 * descriptors its registry serves, and the responses that registry really
 * returns must all appear verbatim in the prompt the diy driver sends. If
 * either side ever drifts — a reformatted brief, a hand-rolled schema dump, a
 * different canned response — this test fails and the comparison is void.
 *
 * Only the MODEL is a double: the prompt under test is the one the driver
 * actually put on the wire, not a string a helper was asked for.
 */
import { hostDesignBrief } from "@vendoai/apps";
import type { RunContext } from "@vendoai/core";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { diyDriver, diySystemPrompt } from "./diy.js";
import type { Meter } from "./meter.js";
import { authoredPage, openBrowser } from "./render.js";
import { designRules, worldRegistry } from "./vendo.js";
import { cannedResponse, loadCases, loadWorld, worldForCase, type Case, type World } from "./world.js";

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
  world = await loadWorld(join(root, "world.json"));
  cases = await loadCases(join(root, "cases.json"));
});

/** The prompt the driver really sent for this case's world. */
async function promptFor(scoped: World, testCase: Case): Promise<{ system: string; user: string }> {
  const { meter, sent } = replying(PAGE);
  await diyDriver().run({ world: scoped, testCase, meter });
  return { system: systemOf(sent()), user: userOf(sent()) };
}

describe("diy is handed exactly what vendo is handed", () => {
  it("carries the product's own design brief verbatim — identity, theme JSON and style lines", async () => {
    const { system } = await promptFor(world, cases[0]!);
    const brief = hostDesignBrief({ theme: world.theme, designRules: designRules(world) });

    // Not a substring of a substring: the whole block, exactly as the vendo
    // driver hands it to the screen assembler.
    expect(brief).toContain(JSON.stringify(world.theme, null, 2));
    expect(brief).toContain(world.style[0]!);
    expect(system).toContain(brief);
  });

  it("carries every descriptor the vendo registry serves, byte for byte", async () => {
    const { system } = await promptFor(world, cases[0]!);
    const descriptors = await worldRegistry(world).descriptors();

    expect(descriptors.length).toBe(world.tools.length);
    for (const descriptor of descriptors) {
      expect(system).toContain(JSON.stringify(descriptor, null, 2));
    }
  });

  it("carries the response that registry actually returns for each tool", async () => {
    const { system } = await promptFor(world, cases[0]!);
    const registry = worldRegistry(world);

    for (const descriptor of await registry.descriptors()) {
      const outcome = await registry.execute({ id: "c1", tool: descriptor.name, args: {} }, CTX);
      expect(outcome.status).toBe("ok");
      expect(system).toContain(JSON.stringify((outcome as { output: unknown }).output, null, 2));
    }
  });

  it("is scoped to the case, so an overridden world reaches diy and the authored one does not", async () => {
    const empty = cases.find((entry) => entry.id === "no-pending-transfers")!;
    const { system } = await promptFor(worldForCase(world, empty), empty);

    expect(system).toContain(JSON.stringify({ data: [] }, null, 2));
    expect(system).not.toContain("Alex Rivera");
  });

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
  it("wraps the canned response in the envelope the prompt describes", async () => {
    const shooter = await openBrowser();
    try {
      const visit = await shooter.visit(
        authoredPage(`<!doctype html><html lang="en"><head><title>t</title></head><body><p>x</p></body></html>`, world, "diy-sonnet"),
      );
      try {
        const answered = await visit.page.evaluate(() =>
          (window as unknown as { vendo: { callTool(name: string, args: unknown): unknown } }).vendo.callTool(
            "list_transfers",
            { limit: 20 },
          ),
        );
        const transfers = world.tools.find((tool) => tool.name === "list_transfers")!;

        expect(answered).toEqual({ status: "ok", output: cannedResponse(transfers) });
        // …and the prompt says exactly that, so the model is not guessing.
        expect(diySystemPrompt(world)).toContain(`{ status: "ok", output:`);
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

    expect(outcome.page).toBe(PAGE);
    expect(outcome.failure).toBeUndefined();
  });

  it("takes the document out of a fenced answer", async () => {
    const { meter } = replying(`Here you go:\n\n\`\`\`html\n${PAGE}\n\`\`\`\n`);
    const outcome = await diyDriver().run({ world, testCase: cases[0]!, meter });

    expect(outcome.page).toBe(PAGE);
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

    expect(outcome.page).toBeUndefined();
    expect(outcome.failure).toBeDefined();
  });
});
