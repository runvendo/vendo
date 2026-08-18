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

/** The same refused document under a DIFFERENT export name — so the title a
 *  refused save records is visibly not the title of the screen on the person's
 *  page. */
const RENAMED_LIE = LYING.replace("function Spending(", "function Overspending(");

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
 *  readable from outside the loop, and with what, which is where a repair round's
 *  instruction shows up. */
function scripted(
  turns: Chunk[][],
): LanguageModel & { calls: number; toolNamesPerCall: string[][]; promptsPerCall: string[] } {
  const remaining = turns.map((turn) => [...turn]);
  const toolNamesPerCall: string[][] = [];
  const promptsPerCall: string[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      (model as { calls: number }).calls += 1;
      toolNamesPerCall.push((request.tools ?? []).map((tool) => tool.name));
      promptsPerCall.push(JSON.stringify(request.prompt));
      const chunks = remaining.shift();
      if (chunks === undefined) throw new Error("scripted model exhausted");
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  }) as unknown as LanguageModel & { calls: number; toolNamesPerCall: string[][]; promptsPerCall: string[] };
  model.calls = 0;
  model.toolNamesPerCall = toolNamesPerCall;
  model.promptsPerCall = promptsPerCall;
  return model;
}

/**
 * The REVIEW seat, scripted: one `report_findings` call, and the rubric it was
 * sent.
 *
 * Its own seat rather than the writer's model, because the reviewer's is a
 * `generateText` call and the loop's is a stream — one mock cannot answer both
 * shapes. `rubrics` is where a host's own design rule is readable after it leaves
 * the briefing pack, which is the whole claim below.
 */
function reviewSeat(
  findings: ReadonlyArray<{ severity: string; where: string; message: string }>,
): LanguageModel & { rubrics: string[] } {
  const rubrics: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (request) => {
      rubrics.push(JSON.stringify(request.prompt));
      return {
        content: [{
          type: "tool-call",
          toolCallId: "rev_1",
          toolName: "report_findings",
          input: JSON.stringify({ findings }),
        }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: ZERO_USAGE,
        warnings: [],
      } as never;
    },
  }) as unknown as LanguageModel & { rubrics: string[] };
  model.rubrics = rubrics;
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
  model: LanguageModel & { calls: number; toolNamesPerCall: string[][]; promptsPerCall: string[] };
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
  /** The REVIEW seat. Absent, the reviewer's call lands on the writer's mock,
   *  which cannot answer a `generateText` — so it reports nothing, which is what
   *  every case above relies on. */
  review?: LanguageModel;
  /** This host's own design rules, exactly as a deployment sets them. */
  designRules?: string;
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
    models: { default: model, ...(options.review === undefined ? {} : { review: options.review }) },
    principal: async () => principal,
    store,
    harness: harness as never,
    ...(options.designRules === undefined ? {} : { apps: { designRules: options.designRules } }),
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
    expect(walked.model.toolNamesPerCall[0] ?? []).toContain("save_app");
    // …and what it must NOT produce, on the real registry that serves them: this
    // is a `vendo_make` with a freshly minted id, so there is no app to open and
    // no records to list. The verbs are graded `read`, so only the composed
    // registry can prove the withholding is not the fixture's doing.
    expect(walked.model.toolNamesPerCall[0] ?? []).not.toContain("vendo_apps_open");
    expect(walked.model.toolNamesPerCall[0] ?? []).not.toContain("vendo_slots_list");
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

/**
 * THE ASK AND THE HOUSE RULES, from the deployment's config to a repair round —
 * the whole chain, with nothing stubbed but the two models.
 *
 * Both halves were live text over an empty slot. The verb had no field for the
 * person's ask, so the reviewer's "sections that don't answer the ask" and "work
 * quietly dropped" judged a screen against `USER_REQUEST:` and nothing after it.
 * The host's design rules reached the WRITER's brief and stopped there, so
 * "ALSO REJECT anything that breaks one of these rules" rendered over an empty
 * list on every deployment. And both land as `warn` — which the gate skipped, so
 * even a rule that DID fire changed nothing.
 */
describe("the ask and the host's rules reach the reviewer, and a warn is repaired", () => {
  const RULE = "Dates are shown as `Aug 7`, never ISO.";
  const BREACH = "the header renders 2026-08-07; this host's rule says dates are shown as `Aug 7`, never ISO";

  it("carries both to the reviewer and spends exactly one repair round on the warn", async () => {
    const review = reviewSeat([{ severity: "warn", where: "<Text> heading", message: BREACH }]);
    const walked = await walk({
      // No RECURRENCE WORD in the ask, deliberately. `make-tool.ts`'s
      // `ASKS_TO_RECUR` reads one as the second half of a compound ask and hands
      // it to the automation planner, which is a whole model call of its own —
      // this case counts the calls the assembly loop spends, so the ask must not
      // also be asking for a schedule. It said "with a monthly total" and the
      // bare adjective tripped the detector.
      request: "show me what I spent this month, with a total for the month",
      designRules: RULE,
      review,
      turns: [
        call("save_app", { content: SPENDING }, "c1"),
        speak("Your spending is on screen."),
        // The repair round…
        speak("fixed the date format."),
        // …and one turn it must never reach: a second round would show up here.
        speak("nobody should read this"),
      ],
    });

    const receipt = makeReceiptSchema.parse((walked.result as { output: unknown }).output);
    expect(receipt.status).toBe("ready");

    // ── the ask travelled: the reviewer judged against the person's own words ──
    expect(walked.model.calls).toBe(3);
    expect(review.rubrics).toHaveLength(1);
    expect(review.rubrics[0] ?? "").toContain("USER_REQUEST: show me what I spent this month, with a total for the month");

    // ── the host's own rule travelled, as a rule the reviewer may reject on ────
    expect(review.rubrics[0] ?? "").toContain("ALSO REJECT");
    expect(review.rubrics[0] ?? "").toContain(RULE);

    // ── and the warn it reported bought a repair round, which a `block`-only
    //    gate would have thrown away ────────────────────────────────────────────
    expect(walked.model.promptsPerCall[2] ?? "").toContain("never ISO");
  }, 60_000);

  it("says nothing about a repair the floor refused — those words describe no screen", async () => {
    // The repair round is the ONE place a save happens after the run has already
    // decided it has a screen. A patch the floor refuses lands its bytes and paints
    // nothing, so the person is still looking at the step-1 screen — and the round's
    // own closing words ("fixed it") and its component's NAME belong to a document
    // that never reached them.
    const review = reviewSeat([{ severity: "warn", where: "<Text> heading", message: BREACH }]);
    const walked = await walk({
      designRules: RULE,
      review,
      turns: [
        // 1. A screen that paints, and the words that describe it.
        call("save_app", { content: SPENDING }, "c1"),
        speak("Your spending is on your screen."),
        // 2. The repair the reviewer bought: renamed, and refused by the floor for
        //    naming a tool this host has not got. No paint, no repaired screen.
        call("save_app", { content: RENAMED_LIE }, "c2"),
        speak("Fixed the date format."),
      ],
    });

    const receipt = makeReceiptSchema.parse((walked.result as { output: unknown }).output);
    // The painted screen STANDS: a patch that failed is not a reason to take away
    // the screen the person can already see.
    expect(receipt.status).toBe("ready");
    // THE DEFECT: the receipt used to carry the repair round's last words and the
    // refused document's name, so the person was told a fix landed on a screen that
    // never changed, under a title they had never seen.
    expect(receipt.say).toBe("Your spending is on your screen.");
    expect(receipt.title).toBe("Spending");
    // …and the refused bytes really did land, which is what makes this the hard
    // case rather than a save that never happened.
    expect(walked.model.promptsPerCall[3] ?? "").toContain("nope_notATool");
  }, 60_000);
});
