/**
 * Beats from inside the SDK loop — contract §3.4, producer half.
 *
 * The user waits 52 seconds while a heavy build runs inside a box. §3.4 gave
 * beats a contract and the wire already carries them; nothing in the loop that
 * does the work ever said anything. These tests are the loop learning to narrate
 * itself, on the channel that already exists.
 *
 * The SDK is the ONE thing doubled here — a unit test cannot run a model. Every
 * message shape below is the shape the real stream yields (verified against
 * @anthropic-ai/claude-agent-sdk 0.3.214's own `sdk-tools.d.ts`).
 */
import { describe, expect, test } from "vitest";
import type { BeatPhase as ContractBeatPhase } from "@vendoai/core";
import {
  createClaudeSession,
  type BeatPhase,
  type ClaudeTurnEvent,
} from "../src/claude-turn.js";

/** One step of a scripted turn: prose, a tool the model used, or both. */
interface ScriptStep {
  say?: string;
  /** An `assistant` tool_use block, exactly as the SDK delivers one. */
  use?: { name: string; input?: Record<string, unknown> };
  /** Deliver `say` as token deltas FIRST, then the completed block — which is
   *  what `includePartialMessages: true` actually produces. */
  stream?: boolean;
}

/** The SDK's stream, one scripted turn per user message pushed in. */
function fakeSdk(turns: ScriptStep[][], subtype = "success", sessionId = "sess_beat") {
  return {
    query: ({ prompt }: { prompt: unknown }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: sessionId, model: "claude-test" };
        let index = 0;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _message of prompt as AsyncIterable<unknown>) {
          for (const step of turns[index] ?? []) {
            if (step.say !== undefined && step.stream === true) {
              yield {
                type: "stream_event",
                event: { type: "content_block_delta", delta: { type: "text_delta", text: step.say } },
              };
            }
            const content: Array<Record<string, unknown>> = [];
            if (step.say !== undefined) content.push({ type: "text", text: step.say });
            if (step.use !== undefined) {
              content.push({ type: "tool_use", name: step.use.name, input: step.use.input ?? {} });
            }
            if (content.length > 0) yield { type: "assistant", message: { content } };
          }
          index += 1;
          yield { type: "result", subtype, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 } };
        }
      },
    }),
  };
}

/** Run `turns.length` messages through ONE live session and return every event. */
async function run(turns: ScriptStep[][], subtype = "success"): Promise<ClaudeTurnEvent[]> {
  const events: ClaudeTurnEvent[] = [];
  const session = createClaudeSession({
    cwd: "/box/user",
    env: {},
    emit: (event) => events.push(event),
    sdk: fakeSdk(turns, subtype) as never,
  });
  for (let index = 0; index < turns.length; index += 1) await session.send(`message ${index}`);
  await session.end();
  return events;
}

/** Just the beats, as `[phase, label]` — the thing every test below reads. */
const beats = (events: ClaudeTurnEvent[]): Array<[BeatPhase | undefined, string]> =>
  events
    .filter((event): event is Extract<ClaudeTurnEvent, { type: "status" }> => event.type === "status")
    .map((beat) => [beat.phase, beat.label]);

describe("the loop narrates itself — one beat per real step (§3.4)", () => {
  test("the session opening IS the first real step", async () => {
    expect(beats(await run([[]]))).toContainEqual(["understanding", "Getting started"]);
  });

  test("the model publishing a task list IS planning", async () => {
    const events = await run([[{ use: { name: "TodoWrite" } }]]);
    expect(beats(events)).toContainEqual(["planning", "Working out the steps"]);
  });

  test("the first write IS building", async () => {
    const events = await run([[{ use: { name: "Write" } }]]);
    expect(beats(events)).toContainEqual(["building", "Putting it together"]);
  });

  test("the turn boundary IS finishing", async () => {
    expect(beats(await run([[]]))).toContainEqual(["finishing", "Finishing up"]);
  });

  test("a whole build reads as the arc of making something, in order", async () => {
    const events = await run([[
      { say: "I'll put together a spending screen." },
      { use: { name: "TodoWrite" } },
      { use: { name: "Write" } },
      { use: { name: "Edit" } },
      { say: "Done." },
    ]]);
    expect(beats(events)).toEqual([
      ["understanding", "Getting started"],
      ["planning", "Working out the steps"],
      ["building", "Putting it together"],
      ["finishing", "Finishing up"],
    ]);
  });

  test("a phase is a STAGE, not a tick: the tenth write is not news", async () => {
    const events = await run([[
      { use: { name: "Write" } },
      { use: { name: "Edit" } },
      { use: { name: "MultiEdit" } },
      { use: { name: "Bash", input: { command: "npm run build" } } },
      { use: { name: "NotebookEdit" } },
      { use: { name: "TodoWrite" } },
      { use: { name: "TodoWrite" } },
    ]]);
    expect(beats(events).filter(([phase]) => phase === "building")).toHaveLength(1);
    expect(beats(events).filter(([phase]) => phase === "planning")).toHaveLength(1);
  });

  test("turn 2 plans and builds again — but nothing 'gets started' twice", async () => {
    const events = await run([
      [{ use: { name: "TodoWrite" } }, { use: { name: "Write" } }],
      [{ use: { name: "TodoWrite" } }, { use: { name: "Write" } }],
    ]);
    const spelled = beats(events).map(([phase]) => phase);
    expect(spelled.filter((phase) => phase === "understanding")).toHaveLength(1);
    expect(spelled.filter((phase) => phase === "planning")).toHaveLength(2);
    expect(spelled.filter((phase) => phase === "building")).toHaveLength(2);
    expect(spelled.filter((phase) => phase === "finishing")).toHaveLength(2);
  });

  test("a turn that FAILED never says it is finishing — the error is the news", async () => {
    const events = await run([[{ use: { name: "Write" } }]], "error_during_execution");
    expect(beats(events).map(([phase]) => phase)).not.toContain("finishing");
    expect(events).toContainEqual({ type: "error", message: "I couldn't finish that one." });
  });

  /**
   * THE DEFECT this closes. `includePartialMessages: true` means prose arrives as
   * deltas and the completed `assistant` message is then a duplicate — so the loop
   * skipped that whole message. A tool_use block rides in the SAME message as the
   * text that introduced it, so every beat in a turn where the model said anything
   * at all was silently thrown away with the duplicate prose.
   */
  test("a tool the model used is still seen when its sentence already streamed", async () => {
    const events = await run([[
      { say: "Let me lay this out.", stream: true, use: { name: "TodoWrite" } },
      { say: "Now the table.", stream: true, use: { name: "Write" } },
    ]]);
    expect(beats(events).map(([phase]) => phase)).toEqual([
      "understanding", "planning", "building", "finishing",
    ]);
    // And the prose is still said exactly once.
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", delta: "Let me lay this out." },
      { type: "text", delta: "Now the table." },
    ]);
  });
});

/**
 * THE COPY LAW, and why it is enforced by CONSTRUCTION here.
 *
 * §3.4: a beat never names a filename, tool slug, model name, token count or id.
 * The tempting source is the model's own text — `TodoWrite`'s `activeForm` is
 * literally documented by the CLI as "the present continuous form shown during
 * execution", which is a beat in all but name. It is also untrusted: it can say
 * "Creating app/src/InvoiceTable.tsx", and admitting it would need a regex gate
 * over model-authored prose. Ruling 14 already tried that and reversed it —
 * "a regex set cannot be the authority for what a person
 * may read", because it admitted raw JSON and exceptions while deleting good
 * copy. Its replacement is a precedence ladder of trusted sources ending in OUR
 * OWN fixed sentence (`consentWords`), and beats have no rung above that one: no
 * host authors beat copy and there is nothing structured to synthesize from.
 *
 * So the loop reads a tool's NAME and nothing else. It never touches `activeForm`,
 * never touches `file_path`, and therefore holds no filename it could leak.
 */
describe("a beat is our copy, never the model's", () => {
  test("nothing a tool's inputs contain reaches the user", async () => {
    const events = await run([[
      {
        say: "Creating app/src/InvoiceTable.tsx now.",
        stream: true,
        use: {
          name: "TodoWrite",
          input: {
            todos: [{
              content: "Create app/src/InvoiceTable.tsx",
              status: "in_progress",
              activeForm: "Creating app/src/InvoiceTable.tsx",
            }],
          },
        },
      },
      { use: { name: "Write", input: { file_path: "/workspace/user/apps/app_9f2/app.vendo" } } },
      { use: { name: "Bash", input: { command: "pnpm vite build --outDir dist" } } },
    ]]);
    const said = beats(events).map(([, label]) => label).join(" | ");
    expect(said).not.toMatch(/InvoiceTable|\.tsx|app\.vendo|app_9f2|vite|TodoWrite|Bash|Write/);
    expect(beats(events)).toEqual([
      ["understanding", "Getting started"],
      ["planning", "Working out the steps"],
      ["building", "Putting it together"],
      ["finishing", "Finishing up"],
    ]);
  });

  test("no beat claims to be about an app — this loop is never told which one", async () => {
    const events = await run([[{ use: { name: "Write", input: { file_path: "/workspace/user/apps/app_1/app.vendo" } } }]]);
    // `appId` is optional in the contract precisely so a producer that does not
    // have one leaves it off instead of parsing one out of a path.
    for (const event of events) {
      if (event.type === "status") expect(event).not.toHaveProperty("appId");
    }
  });

  /**
   * THE OTHER HALF OF THE COPY LAW: a beat says what the builder is DOING, never
   * what the result LOOKS like.
   *
   * The builder cannot see what it is building — it is writing files inside a box,
   * and nothing has been rendered when any of these fire. So an appearance claim
   * is not merely off-tone, it is a claim about something that does not exist yet.
   * Only the receipt's `say` line speaks for the result.
   *
   * This is the same failure Track C hit live: an agent given a short prompt
   * narrated UI it had never seen. A model writing its own todos will cheerfully
   * author "Build beautiful spending dashboard", which is exactly why that text is
   * not the beat source.
   */
  test("no beat claims what the result looks like", async () => {
    const events = await run([[
      { say: "I'll build a beautiful, clean spending dashboard with charts.", stream: true,
        use: { name: "TodoWrite", input: { todos: [{
          content: "Build beautiful spending dashboard with a clean summary table",
          status: "in_progress",
          activeForm: "Building a beautiful dashboard that looks great with charts",
        }] } } },
      { use: { name: "Write" } },
    ]]);
    const said = beats(events).map(([, label]) => label);
    // Appearance vocabulary, and the shapes of a rendered thing. A TEST oracle,
    // never a runtime gate (ruling 14) — the emitter's copy is fixed, so this
    // guards the next person who edits it.
    const APPEARANCE = /beautiful|clean|great|nice|polished|looks?\b|chart|graph|table|dashboard|screen|layout|colou?r|styl|design|pretty|slick|modern/i;
    for (const label of said) expect(label, `beat claims an appearance: "${label}"`).not.toMatch(APPEARANCE);
    // And nothing asserts the visual is DONE — `finishing` is a stage, not a verdict.
    for (const label of said) expect(label).not.toMatch(/ready|done\b|finished\b|complete/i);
    expect(said).toEqual(["Getting started", "Working out the steps", "Putting it together", "Finishing up"]);
  });

  test("a beat stays OFF the transcript vocabulary — it is a status, never text", async () => {
    const events = await run([[{ use: { name: "Write" } }]]);
    const spoken = events.filter((event) => event.type === "text");
    expect(spoken).toEqual([]);
  });
});

/**
 * THE MIRROR SEAM — and where its teeth actually are.
 *
 * `claude-turn.ts` restates core's `BeatPhase` instead of importing it, because
 * that file imports NOTHING (module header: the emitted `dist/claude-turn.js` is
 * copied verbatim into a machine image).
 *
 * The COMPILE-TIME half of that seam deliberately does not live here. Nothing in
 * this repo typechecks a test file — `packages/apps/tsconfig.json` excludes
 * `src/**` + `*.test.ts`, no package defines a `lint` script, and vitest is not
 * run with `--typecheck` — so a type-level assertion in this file would be pure
 * decoration. It lives in gated production code instead: `BEAT_PHASES` in
 * `harnesses/src/claude-code/index.ts` fails when CORE gains a phase the mirror
 * lacks, and the `yield` beside it fails in the other direction. Both were
 * verified red by adding a seventh phase to each side in turn.
 *
 * What IS worth asserting here is the runtime fact: the phases this loop actually
 * puts on the wire are members of the contract's six, spelled the contract's way.
 */
describe("every phase this loop emits is one of the contract's six", () => {
  /** Spelled out as a value, following `harnesses/src/beats.test.ts`'s own
   *  precedent, so a seventh cannot arrive without this line changing on purpose. */
  const ARC: ContractBeatPhase[] = [
    "understanding", "planning", "assembling", "building", "checking", "finishing",
  ];

  test("nothing outside the arc reaches the wire", async () => {
    const events = await run([[{ use: { name: "TodoWrite" } }, { use: { name: "Write" } }]]);
    const emitted = beats(events).map(([phase]) => phase);
    expect(emitted.length).toBeGreaterThan(0);
    for (const phase of emitted) expect(ARC).toContain(phase);
  });

  test("the beats arrive in the order the arc runs", async () => {
    const events = await run([[{ use: { name: "TodoWrite" } }, { use: { name: "Write" } }]]);
    const positions = beats(events).map(([phase]) => ARC.indexOf(phase as ContractBeatPhase));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("the widening is ADDITIVE (§3.4)", () => {
  test("a status with only a label is still exactly what it always was", () => {
    // The dead `{ type: "status"; label: string }` member this PR took its seat in
    // had no `phase` and no `appId`; a producer that says nothing but `label` must
    // put the identical chunk on the wire. `harnesses/src/beats.test.ts` asserts
    // the wire half; this asserts the TYPE still admits the narrow form.
    const bare: ClaudeTurnEvent = { type: "status", label: "Reading your invoices" };
    expect(bare).toEqual({ type: "status", label: "Reading your invoices" });
  });
});
