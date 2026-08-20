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
async function firePostToolUse(options: Record<string, unknown>, file: string): Promise<void> {
  const hooks = options["hooks"] as { PostToolUse?: Array<{ hooks?: PostToolUseHook[] }> } | undefined;
  const hook = hooks?.PostToolUse?.[0]?.hooks?.[0];
  expect(typeof hook).toBe("function");
  await hook!({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: file },
    tool_response: {},
    tool_use_id: "tu_1",
  });
}

/**
 * One turn, as the engine runs it: write the file, fire the hook, then make the
 * tool call the model would make next.
 */
function sdkWritingThenCalling(root: string, nextToolCall: () => void) {
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
          await firePostToolUse(options, file);
          nextToolCall();
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

test("the tool call after a write reaches a store that already holds the write", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vendo-row-"));
  roots.push(root);
  const workspace = testWorkspace({ [SCREEN]: "screen v1" });
  /** What the store held at the moment the model's next tool call went out. */
  let landedBeforeNextCall: boolean | undefined;
  const sandbox = boxRunningTheRealLoop(root, sdkWritingThenCalling(root, () => {
    landedBeforeNextCall = workspace.commits.some((commit) => commit.changed.includes(SCREEN));
  }));

  const guard = testGuard();
  const runtime = createHarnessRuntime({
    tools: boundRegistry({}, guard),
    guard,
    skills: testSkills([]),
    transcript: testTranscript(),
  });
  await readSse(await runtime.run({
    harness: claudeCode({ sandbox, ...testAppsHooks() }) as never,
    threadId: "thr_read_your_own_write" as ThreadId,
    messages: [userMessage("m1", "build me a spending screen")],
    ctx: ctx(),
    workspace,
    models: unusedModels(),
    interactive: true,
  }));

  expect(landedBeforeNextCall).toBe(true);
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
