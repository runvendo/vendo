/**
 * PROOF BAR 1 — "agent → checks → slot proven end to end" (blueprint §15).
 *
 * `vendo_make` is routed through the screen agent, walked through a REAL composed
 * deployment: real store, real guard, real apps pack, the real render seam, the
 * real checks floor. Nothing on either side of the seam is stubbed except the
 * MODEL, which is scripted so the routing — not a provider's mood — is what this
 * measures.
 *
 * The two things a stub could hide, and why they are asserted here rather than in
 * `packages/harnesses`:
 *
 * 1. **The row.** The gauntlet's own paint is what makes a written file an APP:
 *    without it a screen is a picture of one — absent from the person's list,
 *    masked as `not-found` by `vendo_apps_open`. Only a real store can prove it
 *    landed.
 * 2. **The empty answer.** Assembly that produces nothing renderable ends the ask
 *    with a failed receipt, and "nothing else ran" is not something a
 *    harness-level test can claim: it needs the real front door.
 *
 * THE ARTIFACT is `app.tsx` (`SCREEN_FILE`) — one React component the model wrote,
 * which the floor's own component gauntlet compiles, scans, type-checks, runs in
 * the sealed VM and tree-checks before anything paints. Nothing below stubs that
 * gauntlet: these screens go through the real five stages of a real composed
 * deployment, which is why a screen naming a tool this host has not got paints
 * nothing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_MAKE_TOOL,
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
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_screen" };

/** A screen the gauntlet passes and the seam paints — the smallest honest one.
 *
 *  `text`, not `value`: the type check is derived from the Kit's own zod specs, so
 *  a prop the renderer would silently drop is a compile error here. The component's
 *  NAME is the app's title (`screenName`), which is the only title a `.tsx` file
 *  has. */
const SPENDING = `import { Stack, Text } from "@vendo/screen";

export default function Spending() {
  return (
    <Stack gap={12}>
      <Text text="This month" variant="heading" />
    </Stack>
  );
}
`;

/**
 * The same screen reading a tool this deployment has not got.
 *
 * It COMPILES as TSX and its component is a perfectly good component — the only
 * thing wrong with it is a fact about this HOST, which is exactly what the floor
 * is for. The gauntlet's scan stage refuses it by name (`query-tool`), so the seam
 * has nothing to paint. That is what makes it the right probe for §7.1 at a route:
 * if it paints, the floor is not on that route.
 */
const LYING = `import { Stack, Text, useQuery } from "@vendo/screen";

export default function Spending() {
  const spend = useQuery("nope_notATool");
  return (
    <Stack gap={12}>
      <Text text="Last month" variant="heading" />
      <Text text={String(spend)} />
    </Stack>
  );
}
`;

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

/** A model that replays scripted turns, and records how many times it was asked
 *  — and with which tools, which is the only place a composed loadout is
 *  readable from outside the loop. */
function scripted(turns: Chunk[][]): LanguageModel & { calls: number; toolNamesPerCall: string[][] } {
  const remaining = turns.map((turn) => [...turn]);
  const toolNamesPerCall: string[][] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      (model as { calls: number }).calls += 1;
      toolNamesPerCall.push((request.tools ?? []).map((tool) => tool.name));
      const chunks = remaining.shift();
      if (chunks === undefined) throw new Error("scripted model exhausted");
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  }) as unknown as LanguageModel & { calls: number; toolNamesPerCall: string[][] };
  model.calls = 0;
  model.toolNamesPerCall = toolNamesPerCall;
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
  model: LanguageModel & { calls: number; toolNamesPerCall: string[][] };
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
          await turn.workspace.writeFile(`/user/apps/app_written/${SCREEN_FILE}`, content);
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
    models: { default: model },
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
        // …and stops. It never asks to be checked: the save's own gate and the
        // mandatory pass call the `validate` verb themselves, on the SAME registry
        // as every host tool — no privileged side door, and no step spent asking.
        speak("Your spending for this month is on your screen."),
      ],
    });

    // ── the receipt: words, never UI ──────────────────────────────────────────
    expect(walked.result?.status).toBe("ok");
    const receipt = makeReceiptSchema.parse((walked.result as { output: unknown }).output);
    expect(receipt.status).toBe("ready");
    // The title is the app's own name, read off the ROW rather than off the model.
    // A `.tsx` screen has no `<App name>`, so the row's name is the component's own
    // (`screenName`) — which is why the title is the export's name, spaced.
    expect(receipt.title).toBe("Spending");
    // THE RUN'S OWN CLOSING WORDS, verbatim (`ScreenOutcome.say` →
    // `make-tool.ts`'s `routed.say`). Only the thing that built the screen knows
    // what is on it, so nothing between the loop and the receipt rewrites the
    // sentence — the front door's `"<name> is on your screen."` is the fallback for
    // a run that said nothing at all.
    expect(receipt.say).toBe("Your spending for this month is on your screen.");
    // §3.1: no tree, no payload, no URL, no component names — and, now that the
    // artifact is a file the model wrote, none of that source either.
    const spoken = JSON.stringify(receipt);
    expect(spoken).not.toContain("export default");
    expect(spoken).not.toContain("Stack");

    // ── the slot: the compiled description reached the surface ────────────────
    const views = walked.chunks.filter((chunk) => chunk["type"] === "data-vendo-view");
    expect(views.length).toBeGreaterThan(0);
    const painted = views.map((chunk) => chunk["data"] as { appId: string; payload: Record<string, unknown> });
    expect(new Set(painted.map((view) => view.appId))).toEqual(new Set([receipt.id]));
    // The last paint SETTLES — while `streaming` is on, the card never reaches a
    // verdict and stays on "Building your view…".
    expect(painted.at(-1)?.payload["streaming"]).toBe(false);

    // ── the row: the paint made a written file into an APP ────────────────────
    const stored = await walked.vendo.apps.get(receipt.id, { principal, venue: "chat", presence: "present", sessionId: "ses_screen_route" });
    expect(stored?.name).toBe("Spending");
    // And it lists, which is the half that was silently missing before the row.
    const listed = await walked.vendo.apps.list({ principal, venue: "chat", presence: "present", sessionId: "ses_screen_route" });
    expect(listed.map((app) => app.id)).toContain(receipt.id);

    // ── and nothing ran behind it ─────────────────────────────────────────────
    // Exactly two model calls: the save step and the closing one. A second engine
    // picking the ask up would show here as a third.
    expect(walked.model.calls).toBe(2);
  }, 60_000);

  it("refuses to paint a document the checks floor blocks, and the last good view stays", async () => {
    // THE BUG THIS PINS. The screen slot wired the render seam WITHOUT the floor,
    // so a screen assembled through `vendo_make` faced no fact checks and no tsc.
    // A query naming a tool the host has not got painted anyway — an app promising
    // data it can never load — while the very same document written on the
    // harness-turn route was refused. One seam, two answers.
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
    // refuses the paint, never the commit — and the save's own gate is how the
    // model hears about it.
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

  it("equips the assembly loadout on the real route", async () => {
    // The loadout is resolved where the listings are, so the real composed
    // registry — not the unit fixture's — is what has to produce these names.
    const walked = await walk({ turns: [call("save_app", { content: SPENDING }, "c1"), speak("done")] });
    expect(walked.model.toolNamesPerCall[0] ?? []).toContain("vendo_apps_open");
    expect(walked.model.toolNamesPerCall[0] ?? []).toContain("save_app");
  }, 60_000);

  it("fails honestly when assembly produces nothing that renders — no second engine behind it", async () => {
    // The screen agent saves bytes the gauntlet refuses. The seam paints nothing
    // and stores no row, so there is no app — and that is the ANSWER. This used to
    // fall through to the conductor, which meant a broken assembler read as a
    // working deployment.
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
