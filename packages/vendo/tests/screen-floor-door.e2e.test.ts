/**
 * THE FLOOR'S DOOR, ON THE SAVE THAT DID NOT REACH THE SCREEN.
 *
 * Live 2026-08-06 (main @ ce98c546, demo-bank, "a dashboard for my upcoming bills
 * and subscriptions"), the dev server said this and nothing else:
 *
 *   [vendo] render seam: source did not reach the store
 *     { error: 'app_b96… has no row to hold its source' }
 *   [vendo] validate failed: VendoError: app not found: app_b96…
 *
 * One save landed bytes the seam would not paint. No paint means no
 * `AppsRuntime.authored`, so the app has no ROW — and `validate({appId})` is
 * row-scoped (`requireOwned`), so the one door the assembly loop is told to use
 * as its floor ("`validate` is the floor. Call it on what you saved, fix what it
 * names") answered `not-found` on exactly the document that needed judging. The
 * loop learned nothing, saved again, and the screen the person kept was never
 * judged by anything it could hear from.
 *
 * So this walks a REAL composed deployment — real store, real guard, real apps
 * pack, real render seam, the real checks floor, the real `validate` verb — and
 * asserts what the LOOP was told about the bytes it saved. Only the model is
 * scripted, because what is measured is the doors, not a provider's mood.
 *
 * The one that must be able to fail: drop the gate from `save_app`
 * (`packages/harnesses/src/screen-agent.ts`) and the first case goes red — the
 * hand answers "Run validate on it now." over a document that never reached the
 * screen, which is the bypass.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDO_MAKE_TOOL, makeReceiptSchema, type Principal, type ToolResult } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_floor_door" };

/** The smallest document the compiler renders and the seam paints. */
const SPENDING = `<App name="Spending">
  <Stack>
    <Text text="This month" />
  </Stack>
</App>`;

/** Bytes that LAND and never paint: `compileWire` is total, so this yields a
 *  childless synthetic root — nothing to render, no row, and the seam says so
 *  to nobody. */
const BROKEN = "not a document at all";

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

/** The screen agent's own brief (`environmentNote`), which is how a prompt is
 *  known to be the assembly loop's. */
const SCREEN_BRIEF_MARKER = "# In this loop";

interface Scripted {
  model: LanguageModel;
  /** Every prompt the assembly loop was handed, in order. Each one carries the
   *  results of every tool call before it — which is where "what the loop was
   *  told" is actually readable. */
  prompts: string[];
}

/**
 * A model that plays the assembly loop's steps in order, and can read the app id
 * out of its own brief — which is how the live run reached `validate({appId})`
 * and the only way a script can.
 */
function scripted(steps: Array<(prompt: string) => Chunk[]>): Scripted {
  const prompts: string[] = [];
  const remaining = [...steps];
  const answer = (prompt: string): Chunk[] => {
    if (!prompt.includes(SCREEN_BRIEF_MARKER)) return speak(SPENDING);
    const step = remaining.shift();
    return step === undefined ? speak("nothing more to do") : step(prompt);
  };
  const textOf = (request: { prompt?: unknown }): string => JSON.stringify(request.prompt ?? "");
  const model = {
    specificationVersion: "v2",
    provider: "vendo-floor-door",
    modelId: "vendo-floor-door-v1",
    supportedUrls: {},
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
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-floor-door-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** One real `vendo_make` ask, served by the real screen route. */
async function walk(steps: Array<(prompt: string) => Chunk[]>): Promise<{
  result: ToolResult | undefined;
  prompts: string[];
  chunks: Array<Record<string, unknown>>;
  vendo: ReturnType<typeof createVendo>;
}> {
  const store = await tempStore();
  const { model, prompts } = scripted(steps);
  let result: ToolResult | undefined;
  const harness = defineHarness({
    name: "floor-door-probe",
    async *run(turn) {
      result = await turn.tools.call(VENDO_MAKE_TOOL, { request: "show me what I spent this month" });
      yield { type: "text", delta: "ok" };
    },
  });
  const vendo = createVendo({
    model,
    principal: async () => principal,
    store,
    harness: harness as never,
  } as Parameters<typeof createVendo>[0]);
  const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thr_floor_door",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "show me my spending" }] },
    }),
  }));
  const raw = await response.text();
  expect(response.status).toBe(200);
  const chunks = raw
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);
  return { result, prompts, chunks, vendo };
}

/** The app id the brief hands the loop — the same one the live run validated. */
const appIdIn = (prompt: string): string => {
  const match = /app_[0-9a-f-]{36}/.exec(prompt);
  if (match === null) throw new Error("the brief carries no app id");
  return match[0];
};

const saveApp = (content: string, id: string) => () => call("save_app", { content }, id);

/** Everything the operator was told, arguments flattened: an Error prints as its
 *  message and a detail object as its JSON, which is where each half of the live
 *  pair actually lives. */
const operatorLog = (calls: readonly unknown[][]): string => calls
  .flat()
  .map((entry) => {
    if (entry instanceof Error) return entry.message;
    return typeof entry === "string" ? entry : JSON.stringify(entry);
  })
  .join("\n");

describe("the assembly loop always hears the floor's verdict on what it saved", () => {
  it("a save the seam would not paint comes back with the findings, not 'run validate'", async () => {
    // The operator's half of the live incident, captured rather than printed.
    const refusals = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const walked = await walk([
      // 1. The loop saves bytes that land and never paint — no paint, no row.
      saveApp(BROKEN, "c1"),
      // 2. It does exactly what its brief tells it to: validate what it saved, by
      //    the app id the brief named.
      (prompt) => call("validate", { appId: appIdIn(prompt) }, "c2"),
      // 3. It saves something that does render, and stops.
      saveApp(SPENDING, "c3"),
      () => speak("done"),
    ]);

    // What the loop was TOLD about the save it just made — the tool result rides
    // the next prompt, which is the only place the loop can read it.
    const afterFirstSave = walked.prompts[1] ?? "";
    // THE BYPASS: the hand used to answer this with "Run validate on it now." over
    // a document that never reached the screen, and nothing else ever spoke.
    expect(afterFirstSave).toContain("`validate` does not pass");
    // The floor's OWN sentences come back, so the loop repairs instead of guessing.
    // Nothing here is a second implementation of the floor: it is the registered
    // `validate` verb, through the same guarded path as any other tool call.
    expect(afterFirstSave).toContain("wire did not parse to a complete <App> document");
    expect(afterFirstSave).toContain(`${appIdIn(afterFirstSave)}/app.vendo`);

    // …and this is why the hand cannot lean on the door the brief used to name.
    // The loop's own `validate({appId})` — step 2, the id straight off its brief —
    // is row-scoped, and a save that never painted leaves no row, so it refused to
    // judge the one document that needed it.
    //
    // The seam's half stays the operator's: no row is our defect to chase, and the
    // loop can do nothing with it.
    const logged = operatorLog(refusals.mock.calls);
    expect(logged).toContain("has no row to hold its source");
    // The refusal's half is the LOOP's, and it now arrives where the loop can read
    // it — the prompt after the `validate` call. It used to be flattened to
    // "could not complete. Try again", which sent the loop back through a call that
    // can never succeed while the real sentence went only to a log nobody was
    // reading. Same refusal, same run; the door it comes through is the fix.
    expect(walked.prompts[2] ?? "").toContain("app not found");
  }, 120_000);

  it("a save that DOES reach the screen still lands the row, the paint and a ready receipt", async () => {
    const walked = await walk([saveApp(SPENDING, "c1"), () => speak("done")]);

    const receipt = makeReceiptSchema.parse((walked.result as { output: unknown }).output);
    expect(receipt.status).toBe("ready");
    expect(receipt.title).toBe("Spending");
    // The floor passed, so the hand says so rather than handing back a repair list.
    expect(walked.prompts[1] ?? "").not.toContain("does not pass");
    // The screen reached the surface and the row reached the store.
    expect(walked.chunks.filter((chunk) => chunk["type"] === "data-vendo-view").length).toBeGreaterThan(0);
    const stored = await walked.vendo.apps.get(receipt.id, { principal, venue: "chat", presence: "present", sessionId: "ses_floor_door" });
    expect(stored?.name).toBe("Spending");
  }, 120_000);
});
