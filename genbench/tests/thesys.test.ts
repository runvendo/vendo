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
import { meteredModel, MODEL_IDS, usdFor } from "../src/meter.js";
import { probe } from "../src/probe.js";
import { authoredPage, HARNESS_CONTRACT, openBrowser } from "../src/render.js";
import type { RunOutcome } from "../src/run.js";
import { thesysDriver, thesysProvider, THESYS_CALL_USD } from "../src/thesys.js";
import { worldBlock } from "../src/vendo.js";
import { loadCases, loadWorld, worldForCase, type Case, type World } from "../src/world.js";

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

/** What their endpoint really answered with, in the shape it really answered in. */
const completion = (content: string): unknown => ({
  id: "chatcmpl-genbench",
  object: "chat.completion",
  created: 0,
  model: MODEL_IDS.c1,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 18_105, completion_tokens: 254, total_tokens: 18_359 },
});

interface Wire {
  readonly messages: ReadonlyArray<{ role: string; content: string }>;
  /** Their custom actions ride here, as a JSON STRING rather than an object. */
  readonly metadata?: { thesys: string };
}

/** One run of the real driver through the real provider: the request bytes it
 *  produced, and the outcome it returned. */
async function ran(
  scoped: World,
  testCase: Case,
  content: string,
): Promise<{ wire: Wire; outcome: RunOutcome }> {
  let body = "";
  const provider = thesysProvider({
    apiKey: "genbench-test",
    fetch: async (_url, init) => {
      body = String(init?.body);
      return Response.json(completion(content));
    },
  });
  const outcome = await thesysDriver().run({
    world: scoped,
    testCase,
    meter: meteredModel(provider(MODEL_IDS.c1), MODEL_IDS.c1),
  });
  return { wire: JSON.parse(body) as Wire, outcome };
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
    const { wire } = await ran(worldForCase(world, empty), empty, recorded);
    const sent = wire.messages.map((message) => message.content).join("\n");

    expect(sent).toContain(JSON.stringify({ data: [] }, null, 2));
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
});

describe("the thesys driver", () => {
  it("bills the vendor's flat per-call platform fee on top of the pass-through tokens", async () => {
    const { outcome } = await ran(world, caseFor("pending-transfers"), recorded);
    const usage = { inputTokens: 18_105, outputTokens: 254, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 };

    expect(outcome.usd).toBeCloseTo(usdFor(usage, MODEL_IDS.c1) + THESYS_CALL_USD, 10);
  });

  it("fails honestly when the vendor answers without a screen", async () => {
    const { outcome } = await ran(world, caseFor("pending-transfers"), "I can't help with that.");

    expect(outcome.artifact).toBeUndefined();
    expect(outcome.failure).toBeDefined();
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

        // Their action dispatch, through `window.vendo.callTool`, with the
        // action's own type and params — which is what the floor scores.
        const trace = await probe(visit);
        expect(trace.flatMap((pressed) => pressed.calls)).toContainEqual({
          name: "cancel_transfer",
          args: { id: "tr_1" },
        });
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
