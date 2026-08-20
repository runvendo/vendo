/**
 * Read-your-own-write, PostToolUse hook to STORE — the whole chain, no stub in it.
 *
 * A build writes a screen file and its NEXT tool call goes to the host's MCP door:
 * `validate`, `open`, `data_put`. That call must not be able to overtake the
 * workspace sync the write triggered, or the door answers about a store that has
 * never seen the file — observed live as `validate` failing "app not found:
 * app_…" on an appId that validated `{"ok":true}` seconds later, which is a red
 * "couldn't finish" step in the user's chat on every app build.
 *
 * Same chain as `beats-wire.test.ts`, for the same reason: a fake box that
 * SCRIPTS the session cannot disagree with the loop about when the loop's hook
 * returns, so it could never catch this.
 *
 *   scripted SDK, firing the REAL registered PostToolUse hook and awaiting it
 *     → the REAL `createClaudeSession` loop (`src/claude-code/claude-turn.ts`)
 *     → the REAL box door (`packages/harnesses/box/turn-routes.mjs`)
 *     → the REAL `box.ts` poll loop
 *     → the REAL `claude-code/index.ts` hot sync
 *     → the REAL workspace commit
 *
 * The box's collect is deliberately SLOW. The window is a host→box round trip on
 * a real network, and a test that wins the race only by being fast proves nothing
 * about the one that lost it in production.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ThreadId } from "@vendoai/core";
import { createSessionRoutes } from "../../box/turn-routes.mjs";
import { createClaudeSession } from "../../src/claude-code/claude-turn.js";
import { createHarnessRuntime } from "../../src/runtime.js";
import {
  boundRegistry,
  ctx,
  readSse,
  testAppsHooks,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  type TestWorkspace,
  unusedModels,
  userMessage,
} from "../../src/test-doubles.test-util.js";
import { claudeCode } from "../../src/claude-code/index.js";
import {
  disposeSessionMachines,
  type SandboxAdapterLike,
  type SandboxMachineLike,
} from "../../src/claude-code/box.js";
import { disposeLocalSessions, localMachine } from "../../src/claude-code/local.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SCREEN = "/user/apps/app_1/app.tsx";
/** Long enough that losing the race is a certainty rather than a coin toss. */
const COLLECT_MS = 200;

const roots: string[] = [];
afterEach(async () => {
  await disposeSessionMachines();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type PostToolUseHook = (raw: Record<string, unknown>) => Promise<unknown>;

/** The engine's OWN registered `PostToolUse` hook, invoked and awaited exactly
 *  as the engine invokes it — awaiting it is the behaviour under test. */
async function firePostToolUse(
  options: Record<string, unknown>,
  file: string,
): Promise<Record<string, unknown>> {
  const hooks = options["hooks"] as { PostToolUse?: Array<{ hooks?: PostToolUseHook[] }> } | undefined;
  const hook = hooks?.PostToolUse?.[0]?.hooks?.[0];
  expect(typeof hook).toBe("function");
  return await hook!({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: file },
    tool_response: {},
    tool_use_id: "tu_1",
  }) as Record<string, unknown>;
}

/**
 * One turn, as the engine runs it: write the file, fire the hook, then make the
 * tool call the model would make next.
 */
function sdkWritingThenCalling(root: string, nextToolCall: (hookOutput: Record<string, unknown>) => void) {
  return {
    query: ({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "sess_row", model: "claude-test" };
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _message of prompt as AsyncIterable<unknown>) {
          const file = path.join(root, SCREEN.slice(1));
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, "screen v2");
          yield {
            type: "assistant",
            message: { content: [{ type: "tool_use", name: "Write", input: { file_path: file } }] },
          };
          nextToolCall(await firePostToolUse(options, file));
          yield {
            type: "result",
            subtype: "success",
            session_id: "sess_row",
            usage: { input_tokens: 9, output_tokens: 4 },
          };
        }
      },
    }),
  };
}

/** A box that speaks the REAL control-port protocol, running the REAL SDK loop. */
function boxRunningTheRealLoop(root: string, sdk: unknown): SandboxAdapterLike {
  return {
    async create() {
      const routes = createSessionRoutes({
        root,
        // A created machine boots with no token; the first hello claims it.
        token: "",
        env: {},
        openSession: (input: Record<string, unknown>) =>
          createClaudeSession({ ...input, sdk } as never),
      }) as {
        handle: (method: string, pathname: string, headers: Record<string, string>, payload: unknown)
          => Promise<{ status: number; body: unknown }>;
      };
      return {
        id: "box_row",
        async destroy() { /* the root is reaped in afterEach */ },
        async request(req) {
          // The host→box hop the race is actually run across.
          if (req.path === "/session/collect") {
            await new Promise((resolve) => setTimeout(resolve, COLLECT_MS));
          }
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
      } as SandboxMachineLike;
    },
    async destroy() { /* teardown by ref */ },
  };
}

/** One real turn, all the way through the runtime. */
async function runTurn(sandbox: SandboxAdapterLike, workspace: TestWorkspace, thread: string): Promise<void> {
  const guard = testGuard();
  const runtime = createHarnessRuntime({
    tools: boundRegistry({}, guard),
    guard,
    skills: testSkills([]),
    transcript: testTranscript(),
  });
  await readSse(await runtime.run({
    harness: claudeCode({ sandbox, ...testAppsHooks() }) as never,
    threadId: thread as ThreadId,
    messages: [userMessage("m1", "build me a spending screen")],
    ctx: ctx(),
    workspace,
    models: unusedModels(),
    interactive: true,
  }));
}

test("the tool call after a write reaches a store that already holds the write", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vendo-row-"));
  roots.push(root);
  const workspace = testWorkspace({ [SCREEN]: "screen v1" });
  /** What the store held at the moment the model's next tool call went out. */
  let landedBeforeNextCall: boolean | undefined;
  const sandbox = boxRunningTheRealLoop(root, sdkWritingThenCalling(root, () => {
    landedBeforeNextCall = workspace.commits.some((commit) => commit.changed.includes(SCREEN));
  }));

  await runTurn(sandbox, workspace, "thr_read_your_own_write");

  expect(landedBeforeNextCall).toBe(true);
});

test("a hot sync that CONFLICTS tells the model, instead of acking a write that never landed", async () => {
  // The barrier's failure mode matters more than its happy path: releasing on a
  // sync that did NOT happen is the original race back again, minus the
  // evidence. A conflict is the honest version of that — the commit is refused,
  // nothing lands, and `syncHot` used to answer `[]` exactly as it does for an
  // empty diff.
  const root = mkdtempSync(path.join(tmpdir(), "vendo-row-conflict-"));
  roots.push(root);
  const workspace = testWorkspace({ [SCREEN]: "screen v1" });
  workspace.conflictOn = [SCREEN];
  let told: unknown;
  let landedBeforeNextCall: boolean | undefined;
  const sandbox = boxRunningTheRealLoop(root, sdkWritingThenCalling(root, (hookOutput) => {
    told = hookOutput["systemMessage"];
    landedBeforeNextCall = workspace.commits.some((commit) => commit.changed.includes(SCREEN));
  }));

  await runTurn(sandbox, workspace, "thr_read_your_own_write_conflict");

  // Nothing landed — which is precisely why the model has to hear about it.
  expect(landedBeforeNextCall).toBe(false);
  expect(told).toMatch(/has not reached the workspace/);
});

test("an inflated poll cursor does not release a parked write", async () => {
  // The cursor is the HOST's own count coming home. Taken on trust it is not an
  // ack at all: a poll can claim any number and walk every parked write past a
  // sync that never ran.
  const root = mkdtempSync(path.join(tmpdir(), "vendo-row-cursor-"));
  roots.push(root);
  const auth = { "x-vendo-box-token": "tok" };
  let released: string | undefined;
  const routes = createSessionRoutes({
    root,
    token: "tok",
    env: {},
    openSession: (input: Record<string, unknown>) => ({
      async send() {
        const wrote = input["onFileWritten"] as (path: string) => Promise<void>;
        await wrote(`${root}/user/apps/app_1/app.tsx`).then(
          () => { released = "resolved"; },
          () => { released = "threw"; },
        );
      },
      steer: () => false,
      async interrupt() { /* nothing to stop */ },
      async end() { /* nothing to close */ },
    }),
  }) as {
    handle: (method: string, pathname: string, headers: Record<string, string>, payload: unknown)
      => Promise<{ status: number; body: Record<string, unknown> }>;
  };

  const started = await routes.handle("POST", "/session/message", auth, { prompt: "build it" });
  const messageId = String(started.body["messageId"]);
  // A poll that claims to have consumed 999 events when the box has served none.
  const bogus = await routes.handle("POST", `/session/${messageId}/poll`, auth, { cursor: 999, waitMs: 0 });
  expect(bogus.body["events"]).toEqual([]);
  // Drained before asserting, or "still parked" would just mean "has not got
  // round to it yet" and the assertion would hold with no clamp at all.
  await new Promise((resolve) => setImmediate(resolve));
  expect(released).toBeUndefined();

  // The honest sequence still releases it: one poll is served the event, the
  // next carries the cursor back as the ack.
  const served = await routes.handle("POST", `/session/${messageId}/poll`, auth, { cursor: 0, waitMs: 0 });
  expect(served.body["events"]).toEqual([{ type: "wrote", path: `${root}/user/apps/app_1/app.tsx` }]);
  await routes.handle("POST", `/session/${messageId}/poll`, auth, { cursor: 1, waitMs: 0 });
  // The park unwinds through the session's own continuation, not the poll's.
  await new Promise((resolve) => setImmediate(resolve));
  expect(released).toBe("resolved");
});

test("machine: \"local\" holds the model behind its own write too — the rungs are identical", async () => {
  // The local rung has no poll and no ack: the host's sync IS the callback the
  // loop awaits (`local.ts` hands it straight through). So a sync that takes
  // time must delay the model's next call, with nothing stubbed between them.
  const order: string[] = [];
  const sdk = {
    query: ({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "sess_local_row", model: "claude-test" };
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _message of prompt as AsyncIterable<unknown>) {
          await firePostToolUse(options, SCREEN);
          order.push("next tool call");
          yield { type: "result", subtype: "success", session_id: "sess_local_row", usage: {} };
        }
      },
    }),
  };

  const machine = await localMachine({
    threadId: `thr_local_row_${Math.random().toString(36).slice(2)}`,
    env: {},
    openSession: ((input: Record<string, unknown>) =>
      createClaudeSession({ ...input, sdk } as never)) as never,
  });
  await machine.send({
    prompt: "build me a spending screen",
    emit: () => undefined,
    onFileWritten: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push("sync");
    },
  });

  expect(order).toEqual(["sync", "next tool call"]);
  await disposeLocalSessions();
});
