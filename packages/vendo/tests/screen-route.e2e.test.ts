/**
 * PROOF BAR 1 — "agent → checks → slot proven end to end" (blueprint §15).
 *
 * `vendo_make` is routed through the screen agent, walked through a REAL composed
 * deployment: real store, real guard, real apps pack, the real render seam, the
 * real `AppsRuntime.authored` app half. Nothing on either side of the seam is
 * stubbed except the MODEL, which is scripted so the routing — not a provider's
 * mood — is what this measures.
 *
 * The two things a stub could hide, and why they are asserted here rather than in
 * `packages/harnesses`:
 *
 * 1. **The row.** `authored` is what makes a written file an APP: without it a
 *    screen is a picture of one — absent from the person's list, masked as
 *    `not-found` by `vendo_apps_open`. Only a real store can prove it landed.
 * 2. **The empty answer.** Assembly that produces nothing renderable ends the ask
 *    with a failed receipt, and "nothing else ran" is not something a
 *    harness-level test can claim: it needs the real front door.
 *
 * DIALECT NOTE: the `.vendo` literal below is a name, a Stack and a Text with no
 * expressions and no aggregates, so the in-flight dialect change (pipes → nested
 * calls, explicit aggregate field args, `avg` retires) should not touch it. It is
 * still the text to re-check when that lands.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_MAKE_TOOL,
  makeReceiptSchema,
  type Principal,
  type ToolResult,
} from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_screen" };

/** A document the compiler renders and the seam paints — the smallest honest one.
 *
 *  `text`, not `value`: with the checks floor on this route (it was missing, which
 *  is the bug the case below pins) `components-exist` refuses a prop the renderer
 *  would silently drop, so a fixture that spoke the wrong prop name only ever
 *  painted because nothing was checking it. */
const SPENDING = `<App name="Spending">
  <Stack>
    <Text text="This month" />
  </Stack>
</App>`;

/**
 * The same document with a `<Query>` naming a tool this deployment has not got.
 *
 * It COMPILES and it RENDERS — the tree has children, so the seam's own gate waves
 * it through — and only the checks floor's `tools-exist` fact refuses it. That is
 * what makes it the right probe for §7.1 at a route: if it paints, the floor is
 * not on that route.
 */
const LYING = `<App name="Spending">
  <Query id="spend" tool="nope_notATool" />
  <Stack>
    <Text text="Last month" />
  </Stack>
</App>`;

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

/** A model that replays scripted turns, and records how many times it was asked. */
function scripted(turns: Chunk[][]): LanguageModel & { calls: number } {
  const remaining = turns.map((turn) => [...turn]);
  const model = new MockLanguageModelV3({
    doStream: async () => {
      (model as { calls: number }).calls += 1;
      const chunks = remaining.shift();
      if (chunks === undefined) throw new Error("scripted model exhausted");
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  }) as unknown as LanguageModel & { calls: number };
  model.calls = 0;
  return model;
}

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-screen-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

interface Walked {
  /** What the calling agent got back from `vendo_make` — words, never UI. */
  result: ToolResult | undefined;
  /** Everything that crossed the wire to the surface. */
  chunks: Array<Record<string, unknown>>;
  vendo: ReturnType<typeof createVendo>;
  model: LanguageModel & { calls: number };
}

/**
 * One real turn whose harness does exactly what a calling agent does: ask
 * `vendo_make` for a screen in words, and hand back the receipt.
 */
async function walk(options: {
  turns: Chunk[][];
  request?: string;
  /** Skip `vendo_make` entirely and write the documents with the harness's own
   *  hands — the OTHER route into the same seam. */
  writes?: string[];
}): Promise<Walked> {
  const store = await tempStore();
  const model = scripted(options.turns);
  let result: ToolResult | undefined;
  const harness = defineHarness({
    name: "make-probe",
    async *run(turn) {
      if (options.writes !== undefined) {
        for (const [index, content] of options.writes.entries()) {
          await turn.workspace.writeFile(`/user/apps/app_written/app.vendo`, content);
          await turn.workspace.commit({ message: `save ${index}` });
        }
        yield { type: "text", delta: "ok" };
        return;
      }
      result = await turn.tools.call(VENDO_MAKE_TOOL, {
        request: options.request ?? "show me what I spent this month",
      });
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
      threadId: "thr_screen",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "show me my spending" }] },
    }),
  }));
  const raw = await response.text();
  expect(response.status).toBe(200);
  const chunks = raw
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);
  return { result, chunks, vendo, model };
}

describe("vendo_make routed through the screen agent (blueprint §1 point 2)", () => {
  it("assembles, checks, lands the row, paints the slot, and hands back words", async () => {
    const walked = await walk({
      turns: [
        // The agent writes the document with its own hands…
        call("save_app", { content: SPENDING }, "c1"),
        // …runs the review floor on what it saved (the `validate` verb, projected
        // on the SAME registry as every host tool — no privileged side door)…
        call("validate", { document: SPENDING }, "c2"),
        // …and stops.
        speak("done"),
      ],
    });

    // ── the receipt: words, never UI ──────────────────────────────────────────
    expect(walked.result?.status).toBe("ok");
    const receipt = makeReceiptSchema.parse((walked.result as { output: unknown }).output);
    expect(receipt.status).toBe("ready");
    // The title is the app's own name, read off the ROW rather than off the model.
    expect(receipt.title).toBe("Spending");
    expect(receipt.say).toBe("Spending is on your screen.");
    // §3.1: no tree, no payload, no URL, no component names.
    const spoken = JSON.stringify(receipt);
    expect(spoken).not.toContain("<App");
    expect(spoken).not.toContain("Stack");

    // ── the slot: the compiled description reached the surface ────────────────
    const views = walked.chunks.filter((chunk) => chunk["type"] === "data-vendo-view");
    expect(views.length).toBeGreaterThan(0);
    const painted = views.map((chunk) => chunk["data"] as { appId: string; payload: Record<string, unknown> });
    expect(new Set(painted.map((view) => view.appId))).toEqual(new Set([receipt.id]));
    // The last paint SETTLES — while `streaming` is on, the card never reaches a
    // verdict and stays on "Building your view…".
    expect(painted.at(-1)?.payload["streaming"]).toBe(false);

    // ── the row: `authored` made a written file into an APP ───────────────────
    const stored = await walked.vendo.apps.get(receipt.id, { principal, venue: "chat", presence: "present", sessionId: "ses_screen_route" });
    expect(stored?.name).toBe("Spending");
    // And it lists, which is the half that was silently missing before `authored`.
    const listed = await walked.vendo.apps.list({ principal, venue: "chat", presence: "present", sessionId: "ses_screen_route" });
    expect(listed.map((app) => app.id)).toContain(receipt.id);

    // ── and nothing ran behind it ─────────────────────────────────────────────
    // Exactly three model calls: the save step, the validate step, and the closing
    // one. A second engine picking the ask up would show here as a fourth.
    expect(walked.model.calls).toBe(3);
  }, 60_000);

  it("refuses to paint a document the checks floor blocks, and the last good view stays", async () => {
    // THE BUG THIS PINS. The screen slot wired the render seam WITHOUT the floor,
    // so a screen assembled through `vendo_make` compiled with a bare
    // `compileWire`: no fact checks, no binding gate, no tsc. A query naming a
    // tool the host has not got painted anyway — an app promising data it can
    // never load — while the very same document written on the harness-turn route
    // was refused. One seam, two answers.
    const walked = await walk({
      turns: [
        call("save_app", { content: SPENDING }, "c1"),
        call("save_app", { content: LYING }, "c2"),
        speak("done"),
      ],
    });

    const views = walked.chunks.filter((chunk) => chunk["type"] === "data-vendo-view");
    expect(views.length).toBeGreaterThan(0);
    const painted = JSON.stringify(views);
    // The honest save is on screen…
    expect(painted).toContain("This month");
    // …and the blocked one never reached it: no view carries the lie, so the last
    // good view is what the person still sees. The bytes DID land — the floor
    // refuses the paint, never the commit — and `validate` is how the model hears
    // about it.
    expect(painted).not.toContain("Last month");
    expect(painted).not.toContain("nope_notATool");
  }, 60_000);

  it("the harness-turn route answers the same, which is the point of one seam", async () => {
    // The control. This route already carried the floor, so it is the definition
    // of correct behaviour — and the two routes must not disagree about the same
    // bytes.
    const walked = await walk({ turns: [], writes: [SPENDING, LYING] });
    const painted = JSON.stringify(walked.chunks.filter((chunk) => chunk["type"] === "data-vendo-view"));
    expect(painted).toContain("This month");
    expect(painted).not.toContain("Last month");
    expect(painted).not.toContain("nope_notATool");
  }, 60_000);

  it("is ON for every deployment — there is no flag left to compose it behind", async () => {
    // This case used to assert the opposite ("OFF by default"). `experimentalScreenAgent`
    // is deleted: the screen agent is THE engine for a `vendo_make` ask, so the
    // FIRST model call any deployment makes is the assembly loop's.
    //
    // Proved by EXHAUSTION rather than by a flag: exactly two turns are scripted,
    // and the model throws on a third. `save_app` exists only inside the screen
    // agent's closed loadout, so a run that lands a ready receipt in two calls can
    // only have been the assembly loop.
    const walked = await walk({
      turns: [call("save_app", { content: SPENDING }, "c1"), speak("done")],
    });

    expect(walked.model.calls).toBe(2);
    const receipt = makeReceiptSchema.parse((walked.result as { output: unknown }).output);
    expect(receipt.status).toBe("ready");
    expect(receipt.title).toBe("Spending");
  }, 60_000);

  it("fails honestly when assembly produces nothing that renders — no second engine behind it", async () => {
    // The screen agent saves bytes the compiler cannot render. The seam paints
    // nothing and `authored` stores no row, so there is no app — and that is the
    // ANSWER. This used to fall through to the conductor, which meant a broken
    // assembler read as a working deployment.
    const walked = await walk({
      turns: [
        call("save_app", { content: "not a document at all" }, "c1"),
        speak("saved"),
        // Two spare turns the model must never be asked for: if anything runs
        // after assembly gives up, `calls` says so.
        speak("nobody should read this"),
        speak("nor this"),
      ],
    });

    // An in-band receipt, not a thrown tool error: the ask was understood and
    // answered, it just could not be served.
    expect(walked.result?.status).toBe("ok");
    const receipt = makeReceiptSchema.parse((walked.result as { output: unknown }).output);
    expect(receipt.status).toBe("failed");
    expect(receipt.say).toContain("couldn't put that screen together");
    // Nothing painted, and nothing generated after the assembly loop's own two
    // turns — the whole point of cutting the fall-through.
    expect(walked.chunks.filter((chunk) => chunk["type"] === "data-vendo-view")).toHaveLength(0);
    expect(walked.model.calls).toBe(2);
  }, 60_000);
});
