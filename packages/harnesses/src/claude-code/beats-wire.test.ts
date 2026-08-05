/**
 * Beats, SDK loop to WIRE — contract §3.4, the whole chain with no stub in it.
 *
 * `harnesses/src/beats.test.ts` proves the second half (a harness that yields a
 * status reaches `data-vendo-status` with `phase` and `appId` intact, through the
 * real runtime and the real writer). This proves the FIRST half joined to it, so
 * the two together cover the seam end to end:
 *
 *   scripted SDK stream
 *     → the REAL `createClaudeSession` loop, imported from `dist` — the very file
 *       `build-template.mjs` copies into the machine image
 *     → the REAL box door (`packages/apps/box/turn-routes.mjs`), over a transport
 *       adapter instead of a socket
 *     → the REAL `box.ts` poll loop and its `message.emit` forward
 *     → the REAL `claude-code/index.ts` queue passthrough
 *     → the REAL harness runtime and the REAL wire writer
 *     → `readSse`
 *
 * The SDK is the one thing doubled: a unit test cannot run a model. Nothing here
 * mocks any code of ours, which is the point — `claude-code.test.ts`'s fake box
 * SCRIPTS the session and so can never disagree with the loop about what the loop
 * emits. This one runs the loop.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ThreadId } from "@vendoai/core";
import { createSessionRoutes } from "@vendoai/apps/box-door";
import { createClaudeSession } from "@vendoai/apps/claude-turn";
import { createHarnessRuntime } from "../runtime.js";
import { VENDO_STATUS_PART } from "../wire.js";
import {
  boundRegistry,
  ctx,
  readSse,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  unusedModels,
  userMessage,
} from "../test-doubles.test-util.js";
import { BEAT_PHASES, claudeCode } from "./index.js";
import { disposeSessionMachines, type SandboxAdapterLike } from "./box.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One tool the model used, as an `assistant` tool_use block. */
interface Used {
  say?: string;
  use?: { name: string; input?: Record<string, unknown> };
}

/** The SDK's own stream shapes (verified against @anthropic-ai/claude-agent-sdk
 *  0.3.214's `sdk-tools.d.ts`): prose streams as deltas, then the completed
 *  message carrying the same text AND the tool_use block arrives. */
function fakeSdk(script: Used[]) {
  return {
    query: ({ prompt }: { prompt: unknown }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "sess_wire", model: "claude-test" };
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _message of prompt as AsyncIterable<unknown>) {
          for (const step of script) {
            if (step.say !== undefined) {
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
          yield {
            type: "result",
            subtype: "success",
            session_id: "sess_wire",
            usage: { input_tokens: 9, output_tokens: 4 },
          };
        }
      },
    }),
  };
}

const roots: string[] = [];
afterEach(async () => {
  await disposeSessionMachines();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A box that speaks the REAL control-port protocol, running the REAL SDK loop.
 *
 * Deliberately not `claude-code.test.ts`'s fake sandbox: that one injects a
 * SCRIPTED session in place of `createClaudeSession`, which is exactly the
 * counterparty-mocking this test exists to avoid. Here `openSession` builds the
 * real session and hands it the doubled SDK — the pattern `turn-routes.mjs`
 * itself documents ("an injected factory is a test double and brings its own SDK
 * double").
 */
function boxRunningTheRealLoop(script: Used[]): SandboxAdapterLike {
  return {
    async create() {
      const root = mkdtempSync(path.join(tmpdir(), "vendo-beatbox-"));
      roots.push(root);
      const routes = createSessionRoutes({
        root,
        // A created machine boots with no token; the first hello claims it.
        token: "",
        env: {},
        openSession: (input: Record<string, unknown>) =>
          createClaudeSession({ ...input, sdk: fakeSdk(script) } as never),
      }) as {
        handle: (method: string, pathname: string, headers: Record<string, string>, payload: unknown)
          => Promise<{ status: number; body: unknown }>;
      };
      return {
        id: "box_beats",
        async destroy() { /* the root is reaped in afterEach */ },
        async request(req) {
          const payload = req.body === undefined
            ? {}
            : JSON.parse(typeof req.body === "string" ? req.body : decoder.decode(req.body)) as unknown;
          const answer = await routes.handle(
            req.method,
            req.path,
            (req.headers ?? {}) as Record<string, string>,
            payload,
          );
          return { status: answer.status, headers: {}, body: encoder.encode(JSON.stringify(answer.body)) };
        },
      };
    },
    async destroy() { /* teardown by ref */ },
  };
}

/** Run one real turn all the way to SSE and return every transient status chunk. */
async function beatsOnTheWire(script: Used[]): Promise<Array<Record<string, unknown>>> {
  const guard = testGuard();
  const runtime = createHarnessRuntime({
    tools: boundRegistry({}, guard),
    guard,
    skills: testSkills([]),
    transcript: testTranscript(),
  });
  const parts = await readSse(await runtime.run({
    harness: claudeCode({ sandbox: boxRunningTheRealLoop(script) }) as never,
    threadId: "thr_beats_wire" as ThreadId,
    messages: [userMessage("m1", "make me a spending screen")],
    ctx: ctx(),
    workspace: testWorkspace(),
    models: unusedModels(),
    interactive: true,
  }));
  return parts
    .filter((part) => part["type"] === VENDO_STATUS_PART)
    .map((part) => part["data"] as Record<string, unknown>);
}

describe("beats reach the wire from inside the box (§3.4)", () => {
  test("a real build narrates itself, in order, with its phases intact", async () => {
    const beats = await beatsOnTheWire([
      { say: "I'll lay out a spending screen." },
      { use: { name: "TodoWrite", input: { todos: [{ content: "Build the table", status: "in_progress", activeForm: "Building the table" }] } } },
      { use: { name: "Write", input: { file_path: "/workspace/user/apps/app_1/app.vendo" } } },
      { say: "All set." },
    ]);
    expect(beats).toEqual([
      { label: "Getting started", phase: "understanding" },
      { label: "Working out the steps", phase: "planning" },
      { label: "Putting it together", phase: "building" },
      { label: "Finishing up", phase: "finishing" },
    ]);
  });

  test("nothing the model or its tools named reaches the user's screen", async () => {
    const beats = await beatsOnTheWire([
      {
        say: "Creating app/src/InvoiceTable.tsx.",
        use: {
          name: "TodoWrite",
          input: { todos: [{ content: "Create app/src/InvoiceTable.tsx", status: "in_progress", activeForm: "Creating app/src/InvoiceTable.tsx" }] },
        },
      },
      { use: { name: "Bash", input: { command: "pnpm vite build --outDir dist" } } },
    ]);
    const said = beats.map((beat) => String(beat["label"])).join(" | ");
    expect(said).not.toMatch(/InvoiceTable|\.tsx|app\.vendo|vite|TodoWrite|Bash|claude-test|sess_wire/);
    // And no beat invents an app it was never told about.
    for (const beat of beats) expect(beat).not.toHaveProperty("appId");
  });

  /**
   * The runtime half of the mirror seam. `BEAT_PHASES` is the COMPILE-TIME pin —
   * keyed by core's union, valued as the loop's — and it is the only reason the
   * duplicated union is safe. Its compile-time teeth were verified red in both
   * directions; this holds its spelling at runtime, and holds the wire to it.
   */
  test("the phases on the wire are the pinned six, spelled the pinned way", async () => {
    expect(Object.keys(BEAT_PHASES).sort()).toEqual([
      "assembling", "building", "checking", "finishing", "planning", "understanding",
    ]);
    // The map is an identity: a typo on either side of a pair would mean the box
    // emitted a phase string no receiver dispatches on.
    for (const [core, loop] of Object.entries(BEAT_PHASES)) expect(loop).toBe(core);

    const beats = await beatsOnTheWire([{ use: { name: "TodoWrite" } }, { use: { name: "Write" } }]);
    expect(beats.length).toBeGreaterThan(0);
    for (const beat of beats) expect(Object.keys(BEAT_PHASES)).toContain(beat["phase"]);
  });

  test("a beat is EPHEMERAL — the transcript never keeps one", async () => {
    const guard = testGuard();
    const transcript = testTranscript();
    const runtime = createHarnessRuntime({
      tools: boundRegistry({}, guard),
      guard,
      skills: testSkills([]),
      transcript,
    });
    const thread = "thr_beats_wire_ephemeral" as ThreadId;
    await readSse(await runtime.run({
      harness: claudeCode({ sandbox: boxRunningTheRealLoop([{ use: { name: "Write" } }]) }) as never,
      threadId: thread,
      messages: [userMessage("m1", "make me a spending screen")],
      ctx: ctx(),
      workspace: testWorkspace(),
      models: unusedModels(),
      interactive: true,
    }));
    const stored = JSON.stringify(await transcript.list({ kind: "user", subject: "u1" }, thread));
    for (const label of ["Getting started", "Working out the steps", "Putting it together", "Finishing up"]) {
      expect(stored).not.toContain(label);
    }
  });
});
