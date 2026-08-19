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
 * The first of those two is gone: no row YET is not a failure, so `commitSource`
 * skips quietly and says so at info level (write-surface.ts). The second is the
 * one the loop had to hear, and it now arrives in the loop's own prompt.
 *
 * One save landed bytes the seam would not paint. No paint means no row — for a
 * component screen the gauntlet's own `ok` is what earns it (`AppFloorOptions.
 * delivered`) — and `validate({appId})` is row-scoped (`requireOwned`), so the one
 * door the assembly loop was then told to use as its floor answered `not-found` on
 * exactly the document that needed judging. The loop learned nothing, saved again,
 * and the screen the person kept was never judged by anything it could hear from.
 * The loop has no `validate` verb at all now, which makes the hand's own gate the
 * only thing that can speak.
 *
 * So this walks a REAL composed deployment — real store, real guard, real apps
 * pack, real render seam, the real checks floor, the real `validate` verb — and
 * asserts what the LOOP was told about the bytes it saved. Only the model is
 * scripted, because what is measured is the doors, not a provider's mood.
 *
 * The one that must be able to fail: drop the gate from `save_app`
 * (`packages/vendo/src/screen-agent.ts`) and the first case goes red — the hand
 * answers "That save landed." over a document that never reached the screen, which
 * is the bypass.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_MAKE_TOOL,
  type AppId,
  type Principal,
  type ToolResult,
} from "@vendoai/core";
import {
  makeReceiptSchema,
} from "@vendoai/apps/contract";
import { SCREEN_FILE } from "@vendoai/apps";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundRegistry,
  ctx,
  scriptedModel,
  seats,
  testGuard,
  testWorkspace,
  textTurn,
  toolCallTurn,
} from "../src/agent-doubles.test-util.js";
import { screenAssembler } from "../src/screen-agent.js";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_floor_door" };

/** The smallest screen the gauntlet passes and the seam paints. */
const SPENDING = `import { Stack, Text } from "@vendo/screen";

export default function Spending() {
  return (
    <Stack gap={12}>
      <Text text="This month" variant="heading" />
    </Stack>
  );
}
`;

/** Bytes that LAND and never paint: they are not a TSX module, so the gauntlet's
 *  first stage refuses them — nothing to render, no row, and the seam says so to
 *  nobody. */
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
    models: { default: model },
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

const saveApp = (content: string, id: string, decisions?: string) => () =>
  call("save_app", decisions === undefined ? { content } : { content, decisions }, id);

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
    const notes = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const walked = await walk([
      // 1. The loop saves bytes that land and never paint — no paint, no row.
      saveApp(BROKEN, "c1"),
      // 2. It saves something that does render, and stops. It cannot ask to be
      //    checked — there is no `validate` on this loadout — so whatever it hears
      //    about the first save, it hears from the hand.
      saveApp(SPENDING, "c2"),
      () => speak("done"),
    ]);

    // What the loop was TOLD about the save it just made — the tool result rides
    // the next prompt, which is the only place the loop can read it.
    const afterFirstSave = walked.prompts[1] ?? "";
    // THE BYPASS: the hand used to answer this with "Run validate on it now." over
    // a document that never reached the screen, and nothing else ever spoke.
    expect(afterFirstSave).not.toContain("That save landed.");
    // The floor's OWN sentences come back, so the loop repairs instead of guessing.
    // Nothing here is a second implementation of the floor: these are the component
    // gauntlet's own repair instructions, relayed verbatim from the refusal that
    // stopped the paint.
    expect(afterFirstSave).toContain("does not compile as TSX");
    expect(afterFirstSave).toContain("a screen is one plain .tsx module");
    expect(afterFirstSave).toContain(`${appIdIn(afterFirstSave)}/${SCREEN_FILE}`);

    // …and this is why the hand cannot lean on a row-scoped door. `validate({appId})`
    // needs a row, a save that never painted leaves none, and the loop has no
    // `validate` of its own to try it with any more — so `{ document }`, inside the
    // hand, is the only thing that can reach a verdict on these bytes at all.
    //
    // The seam's half stays the operator's, and it is no longer an ERROR. No row
    // YET is not a failure: a paint is what creates the row, the source is already
    // in the workspace files, and the next save that paints persists it. This used
    // to throw `has no row to hold its source`, which the seam printed as "source
    // did not reach the store" — a lost-app alarm over a document the loop was
    // already being told about in the floor's own sentences above.
    expect(operatorLog(refusals.mock.calls)).not.toContain("source did not reach the store");
    expect(operatorLog(notes.mock.calls)).toContain("has no row yet");
  }, 120_000);

  it("a LAST save the seam refused is not a finished screen, whatever an earlier save painted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const walked = await walk([
      // 1. A screen that paints: the row lands and the person is looking at it.
      saveApp(SPENDING, "c1"),
      // 2. The save meant to replace it never reaches the screen.
      saveApp(BROKEN, "c2"),
      // 3. The loop signs off anyway — models do, and no prompt stops them.
      () => speak("Your card is live!"),
    ]);

    // THE DEFECT: `assembled` says only that bytes landed ONCE, so the run used to
    // answer with these words and a ready receipt over the step-1 screen, which is
    // "your card is live" printed over a stale card.
    const receipt = makeReceiptSchema.parse((walked.result as { output: unknown }).output);
    expect(receipt.status).not.toBe("ready");
    expect(receipt.say).not.toContain("Your card is live!");
    // The floor's own sentence travels the whole way out, so what the person hears
    // is what actually happened to the screen they asked for.
    expect(receipt.say).toContain("does not compile as TSX");
  }, 120_000);

  it("a refused save's DECISIONS have nowhere to land, and that is not a fault", async () => {
    // A run whose only save was refused answers with the floor, not with a screen:
    // no paint, no row, and nothing for decisions to hang off. The memory door is
    // never asked, so it never answers `not-found` — which it used to WARN about,
    // sending an operator looking for a broken store behind an expected state.
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const walked = await walk([
      saveApp(BROKEN, "c1", "Totals are the host's; this screen only lists."),
      () => speak("done"),
    ]);

    const receipt = makeReceiptSchema.parse((walked.result as { output: unknown }).output);
    expect(receipt.status).toBe("failed");
    expect(operatorLog(warnings.mock.calls)).not.toContain("decisions were not recorded");
  }, 120_000);

  it("a save that DOES reach the screen still lands the row, the paint and a ready receipt", async () => {
    const walked = await walk([saveApp(SPENDING, "c1"), () => speak("done")]);

    const receipt = makeReceiptSchema.parse((walked.result as { output: unknown }).output);
    expect(receipt.status).toBe("ready");
    expect(receipt.title).toBe("Spending");
    // The floor passed, so the hand says so rather than handing back a repair list.
    expect(walked.prompts[1] ?? "").not.toContain("Never save the whole document");
    // The screen reached the surface and the row reached the store.
    expect(walked.chunks.filter((chunk) => chunk["type"] === "data-vendo-view").length).toBeGreaterThan(0);
    const stored = await walked.vendo.apps.get(receipt.id, { principal, venue: "chat", presence: "present", sessionId: "ses_floor_door" });
    expect(stored?.name).toBe("Spending");
  }, 120_000);
});

/** What the floor says when the refusal is about the DEPLOYMENT: no compiler
 *  where the checks run, so every screen is refused and no rewrite can help. The
 *  real floor mints this from `ScreenToolchainUnavailable`
 *  (`packages/apps/tests/checking/app-floor.test.ts` proves that half); here the
 *  loop's answer to it is what is measured, so the floor is a double. */
const ENVIRONMENT = "the screen could not be compiled: no esbuild is reachable from @vendoai/apps"
  + " — keep this package out of the server bundle, so nothing about this screen was checked.";

describe("a refusal the loop cannot repair ends the run instead of a rewrite round", () => {
  it("spends ONE model call on an environment fault, and never says 'write the file again'", async () => {
    const model = scriptedModel([
      toolCallTurn("save_app", { content: SPENDING }, "c1"),
      toolCallTurn("save_app", { content: SPENDING }, "c2"),
      textTurn("done"),
    ]);
    const assembler = screenAssembler({
      models: seats(model),
      tools: boundRegistry({}, testGuard()),
      workspace: async () => testWorkspace(),
      render: () => ({ floor: { component: async () => ({ ok: false, blocking: [ENVIRONMENT], environment: true }) } }),
    });

    const outcome = await assembler.assemble({ appId: "app_env" as AppId, request: "show me my spending" }, ctx());

    // The person hears the environment's own sentence, not "that build didn't
    // come together" over a screen nothing ever read.
    expect(outcome).toEqual({ kind: "unavailable", why: ENVIRONMENT });
    // THE DEFECT: the floor's sentences used to come back as repair instructions,
    // so the loop rewrote a perfectly good screen until its budget ran out — a
    // paid rewrite round per save, ending in the same refusal.
    expect(JSON.stringify(model.prompts)).not.toContain("write the file again");
    expect(model.calls).toBe(1);
  }, 120_000);
});
