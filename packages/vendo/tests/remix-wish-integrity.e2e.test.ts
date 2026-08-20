/**
 * THE WISH LIST IS THE REMIX — so what goes on it, and what a follow-up edit is
 * allowed to do to the screen, are both data-integrity properties.
 *
 * A remix's `seed.wishes` replays in order on every Update, so anything that
 * lands on it is an edit the person keeps forever. Two ways that went wrong in
 * one live session (Maple, 2026-08-18): one follow-up ask was refused three
 * times and left FOUR entries on the list, and the attempt that finally landed
 * had abandoned the ported source and rewritten the app out of the host's
 * catalog, losing the first wish's edit.
 *
 * Both are seams between the front door, the memory door and the assembly loop,
 * so neither side is stubbed: a real PGlite store, a real `createVendo`, the
 * real `vendo_make` tool called the way a calling agent calls it, the real
 * checks floor, the real screen agent and the real workspace façade. Only the
 * MODEL is scripted — what is measured is the doors.
 *
 * The second test scripts a SOURCE-SENSITIVE model on purpose: it edits the
 * screen when the loop puts one in front of it and writes a catalog card when it
 * does not, which is exactly what the live model did. That makes the assertion
 * about the loop's own prompt, not about a mood — the run is deterministic
 * either way, and the two outcomes are distinguishable in the stored screen.
 *
 * The ones that must be able to fail:
 *  1. drop the `landed` gate in `remember` (`apps/server/doors/write-surface.ts`)
 *     and "a follow-up that does not land" goes red with a second wish.
 *  2. restore the `!(await base.exists(checkout))` guard around `storedScreen`
 *     in `screenAssembler` (`vendo/src/screen-agent.ts`) and "the follow-up edits
 *     the port" goes red: the screen loses the first wish and holds the catalog
 *     card instead.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCREEN_FILE, type SeedBaseline } from "@vendoai/apps";
import { makeReceiptSchema } from "@vendoai/apps/contract";
import { VENDO_MAKE_TOOL, type AppId, type RunContext } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_wish" },
  venue: "app",
  presence: "present",
  sessionId: "session_wish",
};

/** The splitter's output for the slot: real TSX in the screen dialect. */
const PORTED = `import { Stack, Text } from "@vendo/screen";

export default function NetWorthCard() {
  return (
    <Stack gap={12}>
      <Text text="Net worth at Maple" variant="heading" />
      <Text text="$1.2M" />
    </Stack>
  );
}
`;

/** In the port and in nothing else, so any regeneration loses it. */
const PORT_ONLY = 'text="Net worth at Maple"';
/** What the FIRST wish turns it into — the edit that must survive the second. */
const WISH_ONE_LANDED = 'text="Net worth at Maple, mine"';
/** What the SECOND wish turns the figure into. */
const WISH_TWO_LANDED = 'text="$1.3M"';

/**
 * What a run with no screen in front of it writes: a card built out of the
 * host's own catalog, guessing at a component the person never asked for. It
 * shares not one byte with the port, so "did a catalog rewrite land" has a
 * one-string answer.
 */
const CATALOG_REWRITE = `import { Stack, Text } from "@vendo/screen";

export default function NetWorthCard() {
  return (
    <Stack gap={12}>
      <Text text="Rebuilt from the catalog" variant="heading" />
    </Stack>
  );
}
`;
const CATALOG_ONLY = 'text="Rebuilt from the catalog"';

const FIRST_WISH = "say it is mine";
const SECOND_WISH = "say it louder";

/** The screen agent's own brief (`environmentNote`), which is how an assembly
 *  prompt is told apart from the reviewer's. */
const SCREEN_BRIEF_MARKER = "# In this loop";
/** `startingSource`'s own first words — the screen the run must change. */
const STARTING_SOURCE_MARKER = "This app already has a screen";

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

interface Scripted {
  model: LanguageModel;
  /** Every prompt the assembly loop was handed, in order — the only place "what
   *  the loop was told" is readable. */
  prompts: string[];
}

/** A model that plays the assembly loop's steps in order. Anything that is not
 *  the loop — the mandatory reviewer above all — gets plain prose, which reads
 *  as "no findings", so no repair round fires and the run stays deterministic. */
function scripted(steps: Array<(prompt: string) => Chunk[]>): Scripted {
  const prompts: string[] = [];
  const remaining = [...steps];
  const answer = (prompt: string): Chunk[] => {
    if (!prompt.includes(SCREEN_BRIEF_MARKER)) return speak("nothing to report");
    prompts.push(prompt);
    const step = remaining.shift();
    return step === undefined ? speak("nothing more to do") : step(prompt);
  };
  const textOf = (request: { prompt?: unknown }): string => JSON.stringify(request.prompt ?? "");
  const model = {
    specificationVersion: "v2",
    provider: "vendo-remix-wish",
    modelId: "vendo-remix-wish-v1",
    supportedUrls: {},
    async doStream(request: { prompt?: unknown }) {
      const chunks = answer(textOf(request));
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  };
  return { model: model as unknown as LanguageModel, prompts };
}

const baseline: SeedBaseline = {
  slot: "NetWorthCard",
  source: "export default function NetWorthCard() {\n  return <strong>$1.2M</strong>;\n}\n",
  hash: "sha256:maple-net-worth-1",
  exportable: false,
  capturedAt: "2026-08-18T09:00:00.000Z",
  ported: { source: PORTED, tools: [], holes: [] },
};

/**
 * One real turn whose harness does exactly what a calling agent does: ask
 * `vendo_make` in words, naming the host component, and keep the receipts.
 *
 * The ✦ and every follow-up go through that ONE door — which is the door that
 * records the wish, so nothing below it can be reached any other way.
 */
async function walk(
  asks: readonly string[],
  steps: Array<(prompt: string) => Chunk[]>,
) {
  vi.stubEnv("VENDO_BASE_URL", "http://wish.test");
  const root = await mkdtemp(join(tmpdir(), "vendo-remix-wish-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".vendo", "remixable"), { recursive: true });
  await writeFile(
    join(root, ".vendo", "remixable", `${baseline.slot}.json`),
    JSON.stringify(baseline, null, 2),
  );
  const store: VendoStore = createStore({ dataDir: join(root, ".data") });
  await store.ensureSchema();
  cleanups.push(async () => store.close());
  const { model, prompts } = scripted(steps);
  const receipts: Array<ReturnType<typeof makeReceiptSchema.parse>> = [];
  const harness = defineHarness({
    name: "wish-probe",
    async *run(turn) {
      for (const request of asks) {
        const result = await turn.tools.call(VENDO_MAKE_TOOL, { request, component: baseline.slot });
        if (result.status === "ok") receipts.push(makeReceiptSchema.parse(result.output));
      }
      yield { type: "text", delta: "ok" };
    },
  });
  process.chdir(root);
  const vendo = createVendo({
    models: { default: model },
    principal: async () => ctx.principal,
    store,
    harness: harness as never,
  } as Parameters<typeof createVendo>[0]);
  const response = await vendo.handler(new Request("http://wish.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thr_wish",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "remix my net worth card" }] },
    }),
  }));
  expect(response.status).toBe(200);
  await response.text();
  return { vendo, prompts, receipts };
}

/** The app's screen as the ROW holds it — the truth both stores answer to. */
const screenOf = async (
  vendo: Awaited<ReturnType<typeof walk>>["vendo"],
  appId: AppId,
): Promise<string> => (await vendo.apps.get(appId, ctx))?.source?.[SCREEN_FILE]?.text ?? "";

describe("a remix's wish list records what the person got, not what the builder tried", () => {
  it("a follow-up edit that does not land leaves the wish list exactly as it was", async () => {
    const walked = await walk([FIRST_WISH, SECOND_WISH], [
      // The ✦ itself: the first wish, landed on the port.
      () => call("edit_app", { edits: [{ find: PORT_ONLY, replace: WISH_ONE_LANDED }] }, "e1"),
      () => speak("Tightened the heading."),
      // The follow-up, REFUSED: the run never saves, which is the honest failure
      // the front door reports (`this run never saved a screen`). One ask, one
      // failure — and the wish list must not grow by it.
      () => speak("I cannot make that change"),
    ]);

    const appId = walked.receipts[0]!.id as AppId;
    // The failure really reached the person, through the one channel there is.
    expect(walked.receipts[1]?.status).toBe("failed");

    const stored = await walked.vendo.apps.get(appId, ctx);
    // THE PROPERTY: one landed change, one wish. The refused attempt asked for
    // nothing the Update should ever replay.
    expect(stored?.seed?.wishes).toEqual([FIRST_WISH]);
    // …and the person's screen is untouched by the attempt that failed.
    expect(await screenOf(walked.vendo, appId)).toContain(WISH_ONE_LANDED);

    // NOT WEAKENED: `memory.asks` is the next editor's working set and it still
    // holds the ask that failed — "asked for X, then asked for X again, narrower"
    // is the truth an editor needs, and it answers a different question from the
    // replay list beside it.
    expect(stored?.memory?.asks).toContain(SECOND_WISH);
  }, 120_000);

  it("the follow-up edits the PORT, so a refused edit can never become a catalog rewrite", async () => {
    const walked = await walk([FIRST_WISH, SECOND_WISH], [
      () => call("edit_app", { edits: [{ find: PORT_ONLY, replace: WISH_ONE_LANDED }] }, "e1"),
      () => speak("Tightened the heading."),
      // THE LOAD-BEARING STEP. A run handed the screen edits it; a run handed
      // nothing has only the catalog to build from, which is what the live model
      // did on its fourth attempt.
      (prompt) => prompt.includes(STARTING_SOURCE_MARKER)
        ? call("edit_app", { edits: [{ find: 'text="$1.2M"', replace: WISH_TWO_LANDED }] }, "e2")
        : call("save_app", { content: CATALOG_REWRITE }, "c2"),
      () => speak("Raised the figure."),
    ]);

    const appId = walked.receipts[0]!.id as AppId;

    // ── What the loop was TOLD, asserted first: it is the proximate cause of
    // everything below. The follow-up's own prompt carries the screen it must
    // change and the line that forbids replacing it out of the catalog.
    //
    // Found by the ask it carries, never by index. A later drive of the FIRST
    // ask satisfies all three assertions below — it too holds the port with the
    // first wish applied — so a fixed index would go on passing against the
    // wrong prompt the day the loop's drive count changes, and this test would
    // stop pinning the thing it exists for. Only the follow-up's prompts name
    // the second ask: the memory block is written after the edit, so the first
    // run has never heard of it.
    const followUp = walked.prompts.find((prompt) => prompt.includes(SECOND_WISH)) ?? "";
    // The prompt is captured as JSON, so the third assertion reads the
    // quote-free heart of the first wish's edit — a string the port carries only
    // once that wish has landed.
    expect(followUp).toContain(STARTING_SOURCE_MARKER);
    expect(followUp).toContain("never replace it with something built from the");
    expect(followUp).toContain("Net worth at Maple, mine");

    // ── …and what the person is left with.
    const screen = await screenOf(walked.vendo, appId);
    // THE FIRST WISH SURVIVED the second.
    expect(screen).toContain(WISH_ONE_LANDED);
    // The second landed on the port, not beside it.
    expect(screen).toContain(WISH_TWO_LANDED);
    expect(screen).toContain('import { Stack, Text } from "@vendo/screen"');
    // No from-scratch rewrite anywhere near this app.
    expect(screen).not.toContain(CATALOG_ONLY);

    // Both changes landed, so both are wishes — in the order they were asked.
    expect((await walked.vendo.apps.get(appId, ctx))?.seed?.wishes)
      .toEqual([FIRST_WISH, SECOND_WISH]);
  }, 120_000);
});
