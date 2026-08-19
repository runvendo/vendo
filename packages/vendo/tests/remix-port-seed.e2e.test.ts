/**
 * THE ✦ FORK STARTS FROM THE PORT — and the port has to reach BOTH stores.
 *
 * A remix mints an app and then runs the person's instruction through the
 * ordinary edit door. For that edit to be an edit OF THE COMPONENT rather than a
 * fresh generation wearing its name, the splitter's ported source has to be
 * sitting in two independent places by the time the loop starts thinking:
 *
 *   1. `AppDocument.source["app.tsx"]` — what `open()` re-runs and renders.
 *   2. the workspace row at `/user/apps/<appId>/app.tsx` — what `edit_app` reads.
 *
 * They are NOT synced with each other. Seed only the workspace and the app cannot
 * be opened; seed only the document and `edit_app` answers "There is no file to
 * edit yet" and the model rewrites the component from nothing — green suite, dead
 * feature. So this test refuses to stub either side: a real PGlite store, a real
 * `createVendo`, the real checks floor, the real screen agent, the real workspace
 * façade. Only the MODEL is scripted, because what is measured is the doors.
 *
 * THE LOAD-BEARING ASSERTION is the `edit_app` call: its `find` string is lifted
 * VERBATIM from the ported source and appears nowhere else. It can only match if
 * the real port crossed the real seam into the real workspace. A regenerated
 * screen — the behaviour this replaces — fails it by construction.
 *
 * The one that must be able to fail: drop the checkout from `screenAssembler`
 * (packages/vendo/src/screen-agent.ts) and case 2 goes red with the hand's own
 * "There is no file to edit yet".
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCREEN_FILE, type SeedBaseline } from "@vendoai/apps";
import type { AppId, RunContext } from "@vendoai/core";
import { createStore, workspaceStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_remix_port" },
  venue: "app",
  presence: "present",
  sessionId: "session_remix_port",
};

/**
 * The splitter's output for the slot: real TSX in the screen dialect.
 *
 * `PORT_ONLY` below is the part that makes this test a seam test rather than a
 * mood — it is in the port and in nothing else, so any regenerated screen loses
 * it and every assertion that names it goes red.
 */
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

/** A string the PORT has and a regeneration would not. */
const PORT_ONLY = 'text="Net worth at Maple"';
/** What the scripted loop turns it into — proof the edit landed on the port. */
const PORT_EDITED = 'text="Net worth at Maple, mine"';

/** The screen agent's own brief, which is how a prompt is known to be the
 *  assembly loop's rather than the reviewer's. */
const SCREEN_BRIEF_MARKER = "# In this loop";

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
  /** Every prompt the assembly loop was handed, in order. Each carries the
   *  results of every tool call before it — which is the only place "what the
   *  loop was told" is readable. */
  prompts: string[];
}

/** A model that plays the assembly loop's steps in order. Anything that is not
 *  the loop — the mandatory reviewer above all — gets plain prose, which the
 *  reviewer reads as "no findings" (checking/reviewer.ts), so no repair round
 *  fires and the run stays deterministic. */
function scripted(steps: Array<(prompt: string) => Chunk[]>): Scripted {
  const prompts: string[] = [];
  const remaining = [...steps];
  const answer = (prompt: string): Chunk[] => {
    if (!prompt.includes(SCREEN_BRIEF_MARKER)) return speak("nothing to report");
    prompts.push(prompt);
    const step = remaining.shift();
    return step === undefined ? speak("nothing more to do") : step(prompt);
  };
  const model = {
    specificationVersion: "v2",
    provider: "vendo-remix-port",
    modelId: "vendo-remix-port-v1",
    supportedUrls: {},
    async doStream(request: { prompt?: unknown }) {
      const chunks = answer(JSON.stringify(request.prompt ?? ""));
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

/** A deployment whose `.vendo/remixable/` holds exactly these baselines — the
 *  same directory `vendo sync` writes and the umbrella loads (dot-vendo.ts). */
async function deployment(baselines: readonly SeedBaseline[], steps: Array<(prompt: string) => Chunk[]>) {
  const root = await mkdtemp(join(tmpdir(), "vendo-remix-port-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".vendo", "remixable"), { recursive: true });
  const store: VendoStore = createStore({ dataDir: join(root, ".data") });
  await store.ensureSchema();
  cleanups.push(async () => store.close());
  /** The host redeploys: new baselines on disk, a fresh composition, the SAME
   *  store — the shape `drift-reseed.fixture.test.ts` uses to reach a re-seed. */
  const compose = async (
    over: readonly SeedBaseline[],
    script: Array<(prompt: string) => Chunk[]>,
  ) => {
    for (const baseline of over) {
      await writeFile(
        join(root, ".vendo", "remixable", `${baseline.slot}.json`),
        JSON.stringify(baseline, null, 2),
      );
    }
    const { model, prompts } = scripted(script);
    process.chdir(root);
    const vendo = createVendo({
      models: { default: model },
      principal: async () => ctx.principal,
      store,
    });
    return { vendo, prompts };
  };
  const { vendo, prompts } = await compose(baselines, steps);
  return { vendo, store, prompts, compose };
}

/** The app's screen as the ROW holds it — the truth both stores answer to. */
const storedScreenOf = async (
  vendo: Awaited<ReturnType<typeof deployment>>["vendo"],
  appId: AppId,
): Promise<string> => (await vendo.apps.get(appId, ctx))?.source?.[SCREEN_FILE]?.text ?? "";

const baselineWith = (ported: SeedBaseline["ported"]): SeedBaseline => ({
  slot: "NetWorthCard",
  source: "export default function NetWorthCard() {\n  return <strong>$1.2M</strong>;\n}\n",
  hash: "sha256:maple-net-worth-1",
  exportable: false,
  capturedAt: "2026-08-18T09:00:00.000Z",
  ...(ported === undefined ? {} : { ported }),
});

const PORT: SeedBaseline["ported"] = { source: PORTED, tools: [], holes: [] };

/** The host ships a new version of the component: a second baseline, whose port
 *  carries a marker of its own so "did the replay's source reach the row" has a
 *  one-word answer. */
const PORTED_V2 = PORTED.replace("Net worth at Maple", "Net worth, Maple v2");
const V2_ONLY = 'text="Net worth, Maple v2"';
const baselineV2: SeedBaseline = {
  ...baselineWith({ source: PORTED_V2, tools: [], holes: [] }),
  hash: "sha256:maple-net-worth-2",
};

describe("the ✦ fork seeds the splitter's port into both stores", () => {
  it("opens on the PORTED source, and the first edit_app finds and edits that same file", async () => {
    const { vendo, store, prompts } = await deployment([baselineWith(PORT)], [
      // The whole point, in one call: a find/replace against text that exists
      // ONLY in the port. If the workspace held nothing, this answers "There is
      // no file to edit yet"; if it held a regenerated screen, it answers "That
      // text is not in the file". Both are the bug this test exists for.
      () => call("edit_app", { edits: [{ find: PORT_ONLY, replace: PORT_EDITED }] }, "e1"),
      () => speak("Tightened the heading."),
    ]);

    const app = await vendo.apps.seed.from(
      { component: "NetWorthCard", instruction: "say it is mine" },
      ctx,
    );

    // ── THE LOAD-BEARING ONE: what the hand told the loop ───────────────────
    // Asserted FIRST because it is the proximate cause of everything below: the
    // tool's answer rides the NEXT prompt, which is the only place the loop can
    // read it, and these two sentences are `edit_app`'s own refusals
    // (screen-agent.ts). Either of them means the port never crossed the seam.
    const afterEdit = prompts[1] ?? "";
    expect(afterEdit).not.toContain("There is no file to edit yet");
    expect(afterEdit).not.toContain("That text is not in the file");
    expect(afterEdit).toContain('"saved":true');

    // A refused port or a failed first edit leaves this terminal marker in place
    // of a screen, and its reason is the only thing that says which.
    expect(app.buildFailed?.reason).toBeUndefined();

    // ── STORE 1: the document `open()` renders ──────────────────────────────
    // The port is the app's own `app.tsx`, and the loop's edit landed ON it: the
    // rest of the file is the port verbatim, which is what says this app was
    // FORKED rather than regenerated.
    const screen = app.source?.[SCREEN_FILE]?.text ?? "";
    expect(screen).toContain(PORT_EDITED);
    expect(screen).toContain('import { Stack, Text } from "@vendo/screen"');
    expect(screen).toContain('<Text text="$1.2M" />');

    // …and it really opens, on that source. A seeded app used to answer "no
    // screen yet" until a generation landed one (`open()`, persistence/open.ts).
    const opened = await vendo.apps.open(app.id, ctx);
    expect(opened.kind).not.toBe("failed");
    expect(JSON.stringify(opened)).toContain("Net worth at Maple, mine");

    // ── STORE 2: the workspace row `edit_app` reads ─────────────────────────
    // Read back through the real façade, not through anything this test wrote:
    // if the two stores disagree, the app is openable and uneditable, or the
    // reverse, and only reading both can tell.
    const workspace = await workspaceStore(store, {}).open(ctx.principal);
    const onDisk = await workspace.readFile(`/user/apps/${app.id}/${SCREEN_FILE}`);
    expect(onDisk).toBe(screen);
  }, 120_000);

  it("a re-seed whose replay does not land leaves the person's OLD screen in BOTH stores", async () => {
    // The guarantee, and only this one: a replay that fails must not cost the
    // person the screen they already had. It is deliberately NOT a claim that a
    // replay is atomic — a wish list that fails partway may leave a
    // partly-updated screen, which is recoverable through history and is not
    // what this pins.
    const seeded = await deployment([baselineWith(PORT)], [
      () => call("edit_app", { edits: [{ find: PORT_ONLY, replace: PORT_EDITED }] }, "e1"),
      () => speak("Tightened the heading."),
    ]);
    const app = await seeded.vendo.apps.seed.from(
      { component: "NetWorthCard", instruction: "say it is mine" },
      ctx,
    );
    expect(await storedScreenOf(seeded.vendo, app.id)).toContain(PORT_EDITED);

    // The host ships a new component and the person asks for the update — but
    // the replay writes nothing at all. `edit()` reports that in `failure`
    // rather than throwing, which is exactly the path that used to destroy the
    // screen: the new port was painted over the row BEFORE the replay ran.
    const updated = await seeded.compose([baselineV2], [() => speak("I cannot make that change")]);
    const answer = await updated.vendo.apps.seed.reseed({ appId: app.id }, ctx);

    // The row still holds the PERSON'S screen, and not one byte of the new port.
    const row = await storedScreenOf(updated.vendo, app.id);
    expect(row).toContain(PORT_EDITED);
    expect(row).not.toContain(V2_ONLY);
    // …and the provenance did not move, so the drift warning still fires and a
    // retry is not refused as "already up to date".
    expect(answer.seed?.baseline).toBe("sha256:maple-net-worth-1");

    // The WORKSPACE copy too. The replay's starting point is STAGED and never
    // committed, so a run that saves nothing lands nothing — without that, the
    // new port sat in the workspace and the NEXT ordinary edit would have opened
    // it instead of the person's screen and saved it over the top.
    const workspace = await workspaceStore(seeded.store, {}).open(ctx.principal);
    const onDisk = await workspace.readFile(`/user/apps/${app.id}/${SCREEN_FILE}`);
    expect(onDisk).toContain(PORT_EDITED);
    expect(onDisk).not.toContain(V2_ONLY);
  }, 120_000);

  it("an ordinary edit never reaches the replace path — it starts from the person's screen", async () => {
    // The containment property the two-slot split exists for. Only a re-seed
    // publishes a replay source, so an ordinary edit has nothing to take: it
    // must open the screen the person is looking at, never the pristine port.
    const seeded = await deployment([baselineWith(PORT)], [
      () => call("edit_app", { edits: [{ find: PORT_ONLY, replace: PORT_EDITED }] }, "e1"),
      () => speak("Tightened the heading."),
      // The ordinary edit that follows. Its `find` is the text the FIRST edit
      // wrote, which exists only in the person's screen — if the replace path
      // had fired, the workspace would hold the pristine port and this would
      // come back "That text is not in the file".
      () => call("edit_app", { edits: [{ find: PORT_EDITED, replace: 'text="Mine, twice over"' }] }, "e2"),
      () => speak("Done."),
    ]);
    const app = await seeded.vendo.apps.seed.from(
      { component: "NetWorthCard", instruction: "say it is mine" },
      ctx,
    );

    await seeded.vendo.apps.edit(app.id, "say it louder", ctx);

    const afterOrdinary = seeded.prompts[3] ?? "";
    expect(afterOrdinary).not.toContain("That text is not in the file");
    expect(afterOrdinary).not.toContain("There is no file to edit yet");
    expect(await storedScreenOf(seeded.vendo, app.id)).toContain('text="Mine, twice over"');
  }, 120_000);

  it("refuses a component the splitter could not port, and mints nothing", async () => {
    const { vendo } = await deployment([baselineWith(undefined)], [
      () => speak("never reached"),
    ]);

    await expect(vendo.apps.seed.from(
      { component: "NetWorthCard", instruction: "say it is mine" },
      ctx,
    )).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("has no ported source"),
    });

    // No fake fallback and no half-built row: a component with no port has no ✦
    // at all, so there is nothing in the person's list to explain away.
    expect(await vendo.apps.list(ctx)).toEqual([]);
  }, 120_000);
});
