/**
 * A PAINTED SCREEN HAS TO SURVIVE THE FLAGGED POLL.
 *
 * The embed never opens an app any other way: `use-app.ts` always passes
 * `pending: true`, so `GET /apps/:id/open?pending=1` is the ONLY open a remix
 * fork ever performs. That flag exists to turn the build window's expected miss
 * into a quiet `{kind:"pending"}` — but it is also the arm that decides which
 * failures stay failures (`src/wire/apps.ts` `openApp`), and anything that is
 * not `not-found` is re-thrown. A `blocked` refusal raised while PAINTING the
 * screen therefore leaves the flagged poll as an HTTP 403 that repeats forever:
 * the app exists, the person can see it, and the surface never resolves.
 *
 * That is not hypothetical. Until the in-client venue was removed, the painted
 * path performed a per-open engine read of its own — an approval lookup, done
 * unguarded, before the payload was returned — and a deployment whose allowlist
 * had moved past that collection answered every remix open with exactly that
 * 403. The read is gone, and nothing may quietly put one back.
 *
 * THE INTERSECTION THIS PINS, which two suites bracketed and neither covered:
 *   - `seed-wire.test.ts` drives the real seed and the real `?pending=1` route,
 *     but configures no model, so the app never gets a screen and the open
 *     resolves terminal-failed WITHOUT entering the painted path.
 *   - `app-open-terminal-artifact.seam.test.ts` asserts `?pending=1` for a
 *     failed app and for a ghost app, and asserts a healthy painted open only
 *     WITHOUT the flag.
 *   - `remix-port-seed.e2e.test.ts` paints a real fork, but opens it through
 *     `vendo.apps.open(...)` with no `pending` option and no wire leg.
 * So "a real fork, painted, read back through the flagged wire route" had no
 * test, and a regression living in that intersection ships green.
 *
 * Both ends are real: a real PGlite store, a real `createVendo`, the real seed
 * door, the real checks floor, the real screen in the sealed VM, and the real
 * composed HTTP handler. Only the MODEL is scripted, because what is measured
 * is the doors.
 *
 * What must be able to fail: call
 * `assertEngineCollection("vendo_inclient_approvals")` at the top of
 * `paintedScreenSurface` (`@vendoai/apps` persistence/open.ts) — the same
 * unguarded read, in the same place — and this goes red with a 403. Note that
 * routing it through the `venueState` seam instead does NOT reproduce it:
 * `additionalVenueState` catches, so that hook can only cost the payload a key.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeedBaseline } from "@vendoai/apps";
import type { RunContext } from "@vendoai/core";
import { createStore } from "@vendoai/store";
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
  principal: { kind: "user", subject: "user_fork_pending" },
  venue: "app",
  presence: "present",
  sessionId: "session_fork_pending",
};

/** The splitter's output for the slot: real TSX in the screen dialect. */
const PORTED = `import { Stack, Text } from "@vendo/screen";

export default function RentRollTable() {
  return (
    <Stack gap={12}>
      <Text text="Rent roll" variant="heading" />
      <Text text="24 units" />
    </Stack>
  );
}
`;

/** In the port's SOURCE and nowhere else — what the loop's find/replace bites on. */
const PORT_ONLY = 'text="Rent roll"';
/** What the scripted loop writes in its place, still in source dialect. */
const PORT_EDITED = 'text="Rent roll, grouped by status"';
/** …and the same string as the PAINTED tree carries it: a rendered screen is
 *  nodes and props, never source, so this is the form the open actually serves.
 *  Asserting on the EDITED text rather than the port's is what makes the paint
 *  load-bearing — an open that served the unedited port, an empty envelope, or
 *  no screen at all cannot contain it. */
const EDITED_TEXT = "Rent roll, grouped by status";

/** The screen agent's own brief — how a prompt is known to be the assembly
 *  loop's rather than the mandatory reviewer's. */
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

/** A model that plays the assembly loop's steps in order. Anything that is not
 *  the loop — the mandatory reviewer above all — gets plain prose, which the
 *  reviewer reads as "no findings", so no repair round fires and the run stays
 *  deterministic. */
function scripted(steps: Array<() => Chunk[]>): LanguageModel {
  const remaining = [...steps];
  const answer = (prompt: string): Chunk[] => {
    if (!prompt.includes(SCREEN_BRIEF_MARKER)) return speak("nothing to report");
    const step = remaining.shift();
    return step === undefined ? speak("nothing more to do") : step();
  };
  return {
    specificationVersion: "v3",
    provider: "vendo-fork-pending",
    modelId: "vendo-fork-pending-v1",
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
  } as unknown as LanguageModel;
}

const baseline: SeedBaseline = {
  slot: "RentRollTable",
  source: "export default function RentRollTable() {\n  return <strong>24 units</strong>;\n}\n",
  hash: "sha256:keystone-rent-roll-1",
  exportable: false,
  capturedAt: "2026-08-25T09:00:00.000Z",
  ported: { source: PORTED, tools: [], holes: [] },
};

const request = (path: string): Request =>
  new Request(`https://host.test/api/vendo${path}`, { method: "GET" });

describe("a painted remix fork opens through the embed's flagged poll", () => {
  it("serves the painted screen to GET /open?pending=1, instead of 403ing forever", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-fork-pending-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, ".vendo", "remixable"), { recursive: true });
    await writeFile(
      join(root, ".vendo", "remixable", `${baseline.slot}.json`),
      JSON.stringify(baseline, null, 2),
    );
    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);

    const vendo = createVendo({
      models: {
        default: scripted([
          () => call("edit_app", { edits: [{ find: PORT_ONLY, replace: PORT_EDITED }] }, "e1"),
          () => speak("Grouped the rows by status."),
        ]),
      },
      principal: async () => ctx.principal,
      store,
    });

    // The real fork write path — the ✦ gesture's own door.
    const app = await vendo.apps.seed.from(
      { component: baseline.slot, instruction: "group by status with a late subtotal" },
      ctx,
    );
    // The premise: this deployment really painted a screen. Without it a green
    // assertion below would only prove the open declined politely.
    expect(app.buildFailed?.reason).toBeUndefined();

    // ── THE ONE THIS FILE EXISTS FOR ────────────────────────────────────────
    // The real composed handler, the real route, the flag the embed actually
    // sends. A `blocked` raised while painting arrives here as 403; a painted
    // screen mistaken for a build in flight arrives as {kind:"pending"} and the
    // embed skeleton-polls to its deadline. Both are the infinite skeleton.
    const response = await vendo.handler(request(`/apps/${app.id}/open?pending=1`));
    expect(response.status).toBe(200);

    const body = await response.json() as { kind: string };
    expect(body.kind).toBe("tree");
    // …and it is THIS app's painted screen, not an empty envelope wearing the
    // right kind: the edited port text exists only if the fork's screen really
    // rendered and really came back through the flagged route.
    expect(JSON.stringify(body)).toContain(EDITED_TEXT);
  }, 120_000);
});
