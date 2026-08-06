/**
 * THE MEMORY SEAM — the producer and the consumer, with a stub on neither side.
 *
 * An app's memory has two writers and two readers, in different packages, and the
 * only thing that can prove they agree is one run that goes all the way through:
 *
 *   producer  the screen agent's `save_app` hand (`@vendoai/harnesses`) and the
 *             front door's ask recording (`@vendoai/apps`)
 *   store     the real row, through the real `AppsRuntime.remember` door
 *   consumer  the edit brain's brief (`@vendoai/apps` generation), which is what
 *             the NEXT editor actually reads
 *
 * So this is a REAL composed deployment: real store, real guard, real apps pack,
 * real render seam, real checks floor, real front door. Only the MODEL is
 * scripted — this measures what the memory carries, not a provider's mood.
 *
 * The one that must be able to fail: delete the `remember` calls in
 * `agent-tools.ts` and "the three asks, verbatim and in order" goes red; delete
 * the memory block from `brainMessage` and "the edit brief opens with it" goes
 * red. Both re-checked by hand before every push (see the PR).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDO_MAKE_TOOL, makeReceiptSchema, type Principal } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_memory" };
const ctx = { principal, venue: "chat" as const, presence: "present" as const };

/** The smallest document the compiler renders and the seam paints. */
const SPENDING = `<App name="Spending">
  <Stack>
    <Text text="This month" />
  </Stack>
</App>`;

/** The second save of the same run — same app, refined. */
const SPENDING_REFINED = `<App name="Spending">
  <Stack>
    <Text text="This month" />
    <Text text="Trip only" />
  </Stack>
</App>`;

const DECISIONS_FIRST = "Started from the full account list.";
const DECISIONS_LAST = "Filtered to 2 accounts — the ask was trip-only. Ruled out a chart: one number.";

const ASK_CREATE = "show me what I spent this month";
const ASK_EDIT_1 = "say last month instead";
const ASK_EDIT_2 = "and drop the trip-only line";

// ── the scripted model ───────────────────────────────────────────────────────

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

type Chunk = Record<string, unknown>;

const call = (toolName: string, input: unknown, toolCallId: string): Chunk[] => [
  { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
];

const speak = (text: string): Chunk[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
];

/** The screen agent's own brief, verbatim from `environmentNote`. */
const SCREEN_BRIEF_MARKER = "# In this loop";
/** The brain's edit prompt prints the app it is amending; a create's never can. */
const EDIT_MARKER = "THE APP AS IT STANDS";
/** The memory block's own first words (`appMemoryBrief`). */
const MEMORY_MARKER = "THIS APP'S MEMORY";

/** The two edits, in order, so the second amends what the first landed. */
const EDITS = [
  "<Edit><Old>This month</Old><New>Last month</New></Edit>",
  "<Edit><Old>Trip only</Old><New>Everything</New></Edit>",
];

interface Scripted {
  model: LanguageModel;
  /** Every prompt the model was handed, in order. */
  prompts: string[];
}

function scripted(screenTurns: Chunk[][]): Scripted {
  const prompts: string[] = [];
  const screen = screenTurns.map((turn) => [...turn]);
  const edits = [...EDITS];
  const answer = (prompt: string): Chunk[] => {
    if (prompt.includes(SCREEN_BRIEF_MARKER)) return screen.shift() ?? speak("nothing more to do");
    if (prompt.includes(EDIT_MARKER)) return speak(edits.shift() ?? "<Cannot><Reason>no more edits</Reason></Cannot>");
    return speak(SPENDING);
  };
  const textOf = (request: { prompt?: unknown }): string => JSON.stringify(request.prompt ?? "");
  const model = {
    specificationVersion: "v2",
    provider: "vendo-memory",
    modelId: "vendo-memory-v1",
    supportedUrls: {},
    async doGenerate(request: { prompt?: unknown }) {
      const prompt = textOf(request);
      prompts.push(prompt);
      const chunks = answer(prompt);
      const toolCall = chunks.find((chunk) => chunk["type"] === "tool-call");
      if (toolCall !== undefined) {
        return {
          content: [{
            type: "tool-call" as const,
            toolCallId: toolCall["toolCallId"] as string,
            toolName: toolCall["toolName"] as string,
            input: toolCall["input"] as string,
          }],
          finishReason: "tool-calls" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: chunks.filter((chunk) => chunk["type"] === "text-delta").map((chunk) => chunk["delta"] as string).join(""),
        }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream(request: { prompt?: unknown }) {
      const prompt = textOf(request);
      prompts.push(prompt);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const chunk of answer(prompt)) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  };
  return { model: model as unknown as LanguageModel, prompts };
}

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-memory-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** One real turn whose harness does exactly what a calling agent does: ask
 *  `vendo_make` in words, in order, and keep the receipts. */
async function walk(options: {
  screenTurns: Chunk[][];
  asks: Array<{ request: string; context?: string; app?: (previous: string[]) => string }>;
}) {
  vi.stubEnv("VENDO_BASE_URL", "http://memory.test");
  const store = await tempStore();
  const { model, prompts } = scripted(options.screenTurns);
  const ids: string[] = [];
  const harness = defineHarness({
    name: "memory-probe",
    async *run(turn) {
      for (const ask of options.asks) {
        const result = await turn.tools.call(VENDO_MAKE_TOOL, {
          request: ask.request,
          ...(ask.context === undefined ? {} : { context: ask.context }),
          ...(ask.app === undefined ? {} : { app: ask.app(ids) }),
        });
        if (result.status === "ok") ids.push(makeReceiptSchema.parse(result.output).id);
      }
      yield { type: "text", delta: "ok" };
    },
  });
  const vendo = createVendo({
    model,
    principal: async () => principal,
    store,
    harness: harness as never,
  } as Parameters<typeof createVendo>[0]);
  const response = await vendo.handler(new Request("https://memory.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thr_memory",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "make me something" }] },
    }),
  }));
  expect(response.status).toBe(200);
  await response.text();
  return { ids, prompts, vendo };
}

describe("an app remembers what it was asked for, and what was decided", () => {
  it("create → edit → edit lands the three asks verbatim and in order, with the last save's decisions", async () => {
    const walked = await walk({
      // TWO saves in the one assembly run: the second's `decisions` is what the
      // app must end up with — a run that refines its own answer must not leave
      // the superseded note behind.
      screenTurns: [
        call("save_app", { content: SPENDING, decisions: DECISIONS_FIRST }, "c1"),
        call("save_app", { content: SPENDING_REFINED, decisions: DECISIONS_LAST }, "c2"),
        speak("done"),
      ],
      asks: [
        { request: ASK_CREATE },
        { request: ASK_EDIT_1, app: (ids) => ids[0]! },
        { request: ASK_EDIT_2, app: (ids) => ids[0]! },
      ],
    });

    const appId = walked.ids[0]!;
    expect(walked.ids).toEqual([appId, appId, appId]);

    const stored = await walked.vendo.apps.get(appId, ctx);
    // THE ASKS: verbatim, in order, the create ask first. Not a paraphrase, not a
    // summary, not the receipt's title.
    expect(stored?.memory?.asks).toEqual([ASK_CREATE, ASK_EDIT_1, ASK_EDIT_2]);
    // THE DECISIONS: replaced, not appended. Two saves, one block.
    expect(stored?.memory?.decisions).toBe(DECISIONS_LAST);
    expect(stored?.memory?.decisions).not.toContain(DECISIONS_FIRST);
    // The edits really landed — this is a live app whose memory survived two
    // rewrites of its document, not a row nobody touched.
    expect(JSON.stringify(stored)).toContain("Last month");
  }, 60_000);

  it("the edit brief OPENS with the memory — every earlier ask, and the decisions verbatim", async () => {
    const walked = await walk({
      screenTurns: [
        call("save_app", { content: SPENDING, decisions: DECISIONS_LAST }, "c1"),
        speak("done"),
      ],
      asks: [
        { request: ASK_CREATE },
        { request: ASK_EDIT_1, app: (ids) => ids[0]! },
        { request: ASK_EDIT_2, app: (ids) => ids[0]! },
      ],
    });

    // The REAL brief the edit loop was handed, not a rendering of it.
    const editBriefs = walked.prompts.filter((prompt) => prompt.includes(EDIT_MARKER));
    expect(editBriefs.length).toBeGreaterThan(1);
    const last = editBriefs.at(-1)!;

    expect(last).toContain(MEMORY_MARKER);
    // Both EARLIER asks travelled — the second edit's editor knows the app was
    // asked for "this month" and then "last month", which nothing in the
    // document says.
    expect(last).toContain(ASK_CREATE);
    expect(last).toContain(ASK_EDIT_1);
    // …and the decisions the assembly run recorded, verbatim.
    expect(last).toContain("the ask was trip-only");
    // BEFORE the document: the reader meets the filter as a choice, not as a bug
    // to fix. (Both markers are in this one prompt, so the order is the claim.)
    expect(last.indexOf(MEMORY_MARKER)).toBeLessThan(last.indexOf(EDIT_MARKER));
  }, 60_000);

  it("the memory holds what the PERSON said — never the calling agent's `<context>`", async () => {
    const walked = await walk({
      screenTurns: [call("save_app", { content: SPENDING }, "c1"), speak("done")],
      asks: [{
        request: ASK_CREATE,
        // One calling agent's background for one call. Replaying it to every
        // future editor turns a stale aside into a standing requirement.
        context: "the user is on the premium plan and was looking at Q3 earlier",
      }],
    });

    const stored = await walked.vendo.apps.get(walked.ids[0]!, ctx);
    expect(stored?.memory?.asks).toEqual([ASK_CREATE]);
    expect(JSON.stringify(stored?.memory)).not.toContain("premium plan");
    expect(JSON.stringify(stored?.memory)).not.toContain("<context>");
  }, 60_000);
});
