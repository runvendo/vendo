/**
 * The thesys contender, with everything real except the socket.
 *
 * The double is the HTTP boundary and nothing else: the request is built by the
 * same `@ai-sdk/openai-compatible` provider a real run builds, so what these
 * tests read is the bytes that would have left the machine — and the page is
 * assembled by the driver itself and mounted in a real browser through the
 * harness's own seam and pressed by the harness's own probe.
 *
 * The canned answer in `fixtures/thesys-response.txt` was RECORDED from the live
 * API on 2026-08-16, not written here. A DSL nobody's product ever emitted would
 * make every assertion below a statement about this file.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { wiredActions } from "../src/floor.js";
import { meteredModel, MODEL_IDS, usdFor } from "../src/meter.js";
import { probe } from "../src/probe.js";
import { authoredPage, HARNESS_CONTRACT, openBrowser } from "../src/render.js";
import type { RunOutcome } from "../src/run.js";
import { crayonTheme, thesysDriver, thesysProvider, THESYS_CALL_USD } from "../src/thesys.js";
import { worldBlock } from "../src/vendo.js";
import { cannedResponse, loadCases, loadWorld, worldForCase, type Case, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
let cases: readonly Case[];
let recorded: string;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
  cases = await loadCases(join(root, "worlds", "maple", "cases.json"));
  recorded = await readFile(join(root, "tests", "fixtures", "thesys-response.txt"), "utf8");
});

const caseFor = (id: string): Case => cases.find((entry) => entry.id === id)!;

/** What one call to their endpoint answers with: their DSL, or the tools their
 *  model wants run before it will write one. */
type Answer = string | { readonly calls: ReadonlyArray<{ name: string; args: unknown }> };

const PER_CALL = { prompt_tokens: 18_105, completion_tokens: 254, total_tokens: 18_359 };

/** What their endpoint really answered with, in the shape it really answered in. */
const completion = (answer: Answer): unknown => ({
  id: "chatcmpl-genbench",
  object: "chat.completion",
  created: 0,
  model: MODEL_IDS.c1,
  choices: [
    typeof answer === "string"
      ? { index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }
      : {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: answer.calls.map((call, at) => ({
              id: `call_${at}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finish_reason: "tool_calls",
        },
  ],
  usage: PER_CALL,
});

interface Wire {
  readonly messages: ReadonlyArray<{ role: string; content: string | null }>;
  /** The world's tools, in the OpenAI shape their loop reads
   *  (docs.thesys.dev/guides/integrate-data/tool-calling). */
  readonly tools?: ReadonlyArray<{
    type: string;
    function: { name: string; description?: string; parameters: unknown };
  }>;
  /** Their custom actions ride here, as a JSON STRING rather than an object. */
  readonly metadata?: { thesys: string };
}

/** One run of the real driver through the real provider, with their endpoint
 *  answering the scripted turns in order: every request the driver put on the
 *  wire, and the outcome it returned. */
async function ran(
  scoped: World,
  testCase: Case,
  ...answers: readonly Answer[]
): Promise<{ wire: Wire; wires: readonly Wire[]; outcome: RunOutcome }> {
  const wires: Wire[] = [];
  const provider = thesysProvider({
    apiKey: "genbench-test",
    fetch: async (_url, init) => {
      wires.push(JSON.parse(String(init?.body)) as Wire);
      const next = answers[wires.length - 1];
      // Loudly, rather than by repeating the last answer forever: a driver that
      // asks for more turns than a test scripted is a loop nobody bounded, and
      // every turn of it is a call this column pays for.
      if (next === undefined) {
        throw new Error(`the driver called ${wires.length} times for ${answers.length} scripted answers`);
      }
      return Response.json(completion(next));
    },
  });
  const outcome = await thesysDriver().run({
    world: scoped,
    testCase,
    meter: meteredModel(provider(MODEL_IDS.c1), MODEL_IDS.c1),
  });
  // The FIRST request is what this driver says on its own account; everything
  // after it is the loop answering itself.
  return { wire: wires[0]!, wires, outcome };
}

describe("what the thesys column puts on the wire", () => {
  it("sends the shared world block as its whole system prompt and the case as its whole user turn", async () => {
    const { wire } = await ran(world, caseFor("pending-transfers"), recorded);

    expect(wire.messages).toEqual([
      { role: "system", content: worldBlock(world) },
      { role: "user", content: caseFor("pending-transfers").prompt },
    ]);
  });

  it("adds nothing of its own — no harness contract, and no coaching around it", async () => {
    const { wire } = await ran(world, caseFor("pending-transfers"), recorded);
    const sent = wire.messages.map((message) => message.content).join("\n");
    // What this driver says on its OWN account: the request minus the two blocks
    // every column shares. `diy.test.ts` fences that residue against a list of
    // mechanics words; here the residue is empty, which is that fence's strongest
    // form — this column's wiring is the driver's job, not the prompt's.
    const own = sent.replace(worldBlock(world), "").replace(caseFor("pending-transfers").prompt, "").trim();

    expect(own).toBe("");
    expect(sent).not.toContain(HARNESS_CONTRACT);
  });

  it("is scoped to the case, so an overridden world reaches the vendor and the authored one does not", async () => {
    const empty = caseFor("no-pending-transfers");
    const scoped = worldForCase(world, empty);
    const { wire } = await ran(scoped, empty, recorded);
    const sent = wire.messages.map((message) => message.content).join("\n");
    const overridden = scoped.tools.find((entry) => entry.name === "list_transfers")!;
    const authored = world.tools.find((entry) => entry.name === "list_transfers")!;

    // The override moves the DERIVED output schema, which is the only place a
    // case's data reaches a prompt at all now — the same reading `diy.test.ts`
    // takes of the same block: an empty read declares an array of nothing, and
    // the authored one declares an array of rows.
    expect(overridden.descriptor).not.toEqual(authored.descriptor);
    expect(sent).toContain(JSON.stringify(overridden.descriptor, null, 2));
    expect(sent).not.toContain(JSON.stringify(authored.descriptor, null, 2));
    expect(sent).not.toContain("Alex Rivera");
  });

  it("declares the world's tools as C1 custom actions, with the schemas the registry derives", async () => {
    const { wire } = await ran(world, caseFor("pending-transfers"), recorded);
    // A JSON STRING, not a nested object (docs.thesys.dev/guides/custom-actions).
    // An object there is accepted and silently ignored, so the actions are read
    // back out of the string the request really carried.
    const declared = JSON.parse(wire.metadata!.thesys) as { c1_custom_actions: unknown };

    expect(world.tools.length).toBeGreaterThan(0);
    expect(declared.c1_custom_actions).toEqual(
      Object.fromEntries(world.tools.map((tool) => [tool.name, tool.descriptor.inputSchema])),
    );
  });

  /** Custom actions are what a GENERATED control dispatches; these are what the
   *  model may call while it is still building. Two different features of their
   *  product, and this column was buying only the first — so their model drew
   *  every screen without seeing one value, because no contender is handed data
   *  in a prompt. */
  it("declares the world's tools as tools their model can call, with the registry's own schemas", async () => {
    const { wire } = await ran(world, caseFor("pending-transfers"), recorded);

    expect(wire.tools?.map((declared) => declared.function.name)).toEqual(world.tools.map((tool) => tool.name));
    for (const tool of world.tools) {
      const declared = wire.tools!.find((entry) => entry.function.name === tool.name)!;
      expect(declared.type).toBe("function");
      expect(declared.function.description).toBe(tool.descriptor.description);
      expect(declared.function.parameters).toEqual(tool.descriptor.inputSchema);
    }
  });
});

describe("the thesys driver", () => {
  it("bills the vendor's flat per-call platform fee on top of the pass-through tokens", async () => {
    const { outcome } = await ran(world, caseFor("pending-transfers"), recorded);
    const usage = { inputTokens: 18_105, outputTokens: 254, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 };

    expect(outcome.usd).toBeCloseTo(usdFor(usage, MODEL_IDS.c1) + THESYS_CALL_USD, 10);
  });

  /** Their model asking for data, and being answered — the loop their own guide
   *  describes (docs.thesys.dev/guides/integrate-data/tool-calling). A tool
   *  RESULT is the only door this benchmark opens to values: no contender reads
   *  a row in its prompt, so a column that cannot call cannot draw the world's
   *  data at all. */
  it("answers a tool call with the world's own rows, and the screen is the last turn's DSL", async () => {
    const asked = { calls: [{ name: "list_transfers", args: { limit: 20 } }] };
    const { wires, outcome } = await ran(world, caseFor("pending-transfers"), asked, recorded);
    const transfers = world.tools.find((tool) => tool.name === "list_transfers")!;

    expect(wires).toHaveLength(2);
    const answered = wires[1]!.messages.filter((message) => message.role === "tool");
    expect(answered).toHaveLength(1);
    // The same envelope `world-tools` prints for the agentic columns and the
    // page's own bridge answers with, around the same canned rows.
    expect(JSON.parse(answered[0]!.content!)).toEqual({ status: "ok", output: cannedResponse(transfers) });
    // The screen is what the model said AFTER it had the rows, and it is graded.
    expect(outcome.artifact).toContain("\\u003ccontent");
    expect(outcome.failure).toBeUndefined();
  });

  it("bills the flat fee on every turn of that loop, not once for the case", async () => {
    const asked = { calls: [{ name: "list_transfers", args: { limit: 20 } }] };
    const { outcome } = await ran(world, caseFor("pending-transfers"), asked, recorded);
    const usage = { inputTokens: 2 * 18_105, outputTokens: 2 * 254, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 2 };

    expect(outcome.usd).toBeCloseTo(usdFor(usage, MODEL_IDS.c1) + 2 * THESYS_CALL_USD, 10);
  });

  /** The bound the case's clock cannot supply: a model that keeps asking is
   *  answered, and every answer is a paid call. */
  it("stops buying turns for a model that never stops calling", async () => {
    const asked = { calls: [{ name: "list_transfers", args: {} }] };
    const { wires, outcome } = await ran(world, caseFor("pending-transfers"), ...Array<Answer>(20).fill(asked));

    // It kept asking and it was cut off: a driver that never looped at all would
    // also have stopped short, and that is the bug this column just had.
    expect(wires.length).toBeGreaterThan(1);
    expect(wires.length).toBeLessThan(20);
    expect(outcome.artifact).toBeUndefined();
    expect(outcome.failure).toBeDefined();
  });

  it("fails honestly when the vendor answers without a screen", async () => {
    const { outcome } = await ran(world, caseFor("pending-transfers"), "I can't help with that.");

    expect(outcome.artifact).toBeUndefined();
    expect(outcome.failure).toBeDefined();
  });
});

describe("the world's brand in the vendor's tokens", () => {
  /** Their charts read `defaultChartPalette` off the theme and fall back to
   *  their own blue when it is unset (`palette = customPalette ||
   *  paletteFromTheme || paletteFromChartTheme.colors` in their
   *  `Charts/utils/PalletUtils`). Leaving it unset painted a Maple chart in
   *  another product's blue, which is our mapping missing a token they honour
   *  rather than a limit of theirs. */
  it("paints the world's charts in the world's accent, not the vendor's default", () => {
    const palette = crayonTheme(world.theme).defaultChartPalette;

    expect(palette.length).toBeGreaterThan(5);
    // A ramp OF the accent: its darkest steps keep the accent's own hue order
    // (a green world stays greenest in green), and none of it is their blue.
    for (const step of palette) expect(step).toMatch(/^#[0-9a-f]{6}$/i);
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(palette.at(-1)!.slice(at, at + 2), 16));
    expect(g).toBeGreaterThan(r!);
    expect(g).toBeGreaterThan(b!);
  });
});

describe("the page the vendor's renderer paints", () => {
  /** A SEAM test: the driver's real page, the vendor's real renderer, the
   *  harness's real recorder and the harness's real probe, in a real browser
   *  with no network at all. Their renderer is the only thing that can read
   *  their DSL, so this is the only place the column's screen can be proven. */
  it("mounts their screen offline, and a press lands in the harness's recorder", async () => {
    const { outcome } = await ran(world, caseFor("pending-transfers"), recorded);
    const shooter = await openBrowser();
    try {
      const visit = await shooter.visit(authoredPage(outcome.artifact!, world, "thesys-c1"));
      try {
        const shot = await visit.shot();

        expect(shot.consoleErrors).toEqual([]);
        expect(shot.renders).toBe(true);
        expect(shot.visibleText).toContain("Alex Rivera");

        // The judge's SOURCE channel is this DOM with script bodies dropped
        // (`render.ts`), the same mechanical rule for every column. Their
        // renderer's stylesheet rides in a `<style>`, which that rule does not
        // drop, so anything bulky inlined THERE lands in the judge's prompt:
        // inlining their font files as data URLs put this column alone past the
        // grader's context (1.69M tokens) and made it ungradeable. Asserted on
        // the driver's own page, because the harness injects the world's face as
        // a data URL afterwards and that one belongs to every column alike.
        expect(outcome.artifact).not.toMatch(/data:font/i);
        expect(shot.dom.length).toBeLessThan(1_000_000);

        // Their action dispatch, through `window.vendo.callTool`, with the
        // action's own type and params — which is what the floor scores.
        // `objectContaining`, because a write also carries what the seam's guard
        // did with it (`status`, `approvalId`) — evidence beside the name and
        // arguments, never instead of them.
        const trace = await probe(visit);
        expect(trace.flatMap((pressed) => pressed.calls)).toContainEqual(
          expect.objectContaining({ name: "cancel_transfer", args: { id: "tr_1" } }),
        );

        // `toContainEqual` treats an undefined-valued key as absent, so the
        // assertion above holds even when the dispatch carries junk. The floor
        // does NOT: `checkArgs` walks the object's own keys and rejects the
        // first one the tool's schema does not declare. Their renderer hands
        // `onAction` every param slot it knows, undefined ones included, so
        // this is the assertion that speaks for the score.
        const cancels = trace.flatMap((pressed) => pressed.calls).filter((call) => call.name === "cancel_transfer");
        expect(cancels.length).toBeGreaterThan(0);
        for (const call of cancels) expect(Object.keys(call.args as object)).toEqual(["id"]);

        // The real floor verdict, on the real trace: a perfect press must score.
        const scored = wiredActions(trace, world, caseFor("pending-transfers").tags);
        expect(scored.bindings.filter((binding) => binding.tool === "cancel_transfer")).not.toHaveLength(0);
        for (const binding of scored.bindings.filter((binding) => binding.tool === "cancel_transfer")) {
          expect(binding.argsValid).toBe(true);
        }
      } finally {
        await visit.close();
      }
    } finally {
      await shooter.close();
    }
  }, 180_000);
});

/** ONE live generation, off unless asked for. Every double above answers "does
 *  the driver read their product correctly"; only this one answers "is this a
 *  request their product accepts", which no fixture can. */
const LIVE = process.env.GENBENCH_LIVE === "1" && (process.env.THESYS_API_KEY ?? "") !== "";

describe.skipIf(!LIVE)("one live generation", () => {
  it(
    "builds a real screen for a real case, and says what it cost",
    async () => {
      const testCase = caseFor("pending-transfers");
      const provider = thesysProvider({ apiKey: process.env.THESYS_API_KEY! });
      const outcome = await thesysDriver().run({
        world: worldForCase(world, testCase),
        testCase,
        meter: meteredModel(provider(MODEL_IDS.c1), MODEL_IDS.c1),
      });

      console.log(
        `live thesys · ${outcome.settledMs} ms · $${(outcome.usd ?? 0).toFixed(4)} · ${outcome.artifact?.length ?? 0} bytes`,
      );
      expect(outcome.failure).toBeUndefined();
      // Their DSL really arrived and the driver really wrapped it in a page.
      // `<` because `jsonScript` escapes every `<` it inlines.
      expect(outcome.artifact).toContain("\\u003ccontent");
      expect(outcome.artifact).toContain('<div id="root">');
    },
    6 * 60_000,
  );
});
