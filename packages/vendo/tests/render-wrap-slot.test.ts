/**
 * The render seam riding the harness runtime's generic `wrapWorkspace` slot —
 * §1.6, the PRODUCER/CONSUMER pair with no stub on either side.
 *
 * The runtime (`@vendoai/harnesses`) no longer imports the seam; composition
 * injects `wrapWorkspaceForRender` (`@vendoai/apps`) through the slot, exactly
 * as `harness-turn.ts` does. These tests moved here from
 * `packages/harnesses/tests/runtime.test.ts` when harnesses dropped its apps
 * dependency: the pair they pin spans both blocks, so the umbrella — which
 * depends on both — is where they can keep driving the REAL wrap. What they
 * pin is the SLOT: the wrap sees every commit, and its `emit` reaches the
 * wire's view channel.
 */
import { createAppFloor, wrapWorkspaceForRender } from "@vendoai/apps";
import type { Harness, ThreadId } from "@vendoai/core";
import {
  createHarnessRuntime,
  defineHarness,
  memoryHarnessStateStore,
  type TurnRunInput,
} from "@vendoai/harnesses";
import { describe, expect, it } from "vitest";
import {
  boundRegistry,
  ctx,
  readSse,
  readTool,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  unusedModels,
  userMessage,
} from "../src/agent-doubles.test-util.js";

const THREAD = "thr_1" as ThreadId;

/** The one screen the gauntlet passes — its component's name is the app's. */
const SCREEN = `import { Stack, Text } from "@vendo/screen";

export default function Invoices() {
  return (
    <Stack gap={12}>
      <Text text="Unpaid" variant="heading" />
    </Stack>
  );
}
`;

function fixture(options: {
  tools?: Record<string, { descriptor: ReturnType<typeof readTool>; execute: () => unknown }>;
} = {}) {
  const guard = testGuard();
  const registry = boundRegistry(
    (options.tools ?? {}) as Parameters<typeof boundRegistry>[0],
    guard,
  );
  // THE REAL FLOOR — the seam paints an `app.tsx` only through
  // `AppFloor.component`, so without it nothing would paint and this file would
  // measure nothing. Kit-only, and the row half is the one double (it needs a
  // store).
  const floor = createAppFloor({
    deps: async () => ({ catalog: [], tools: [] }),
    runQuery: async () => ({}),
    delivered: async () => undefined,
  });
  const runtime = createHarnessRuntime({
    tools: registry,
    guard,
    skills: testSkills(),
    transcript: testTranscript(),
    harnessState: memoryHarnessStateStore(),
    // The slot fill under test — verbatim what composition does
    // (`packages/vendo/src/harness-turn.ts`).
    wrapWorkspace: (workspace, opts) => wrapWorkspaceForRender(workspace, {
      floor,
      turnId: opts.turnId,
      emit: opts.emit,
    }),
  });
  const run = async (
    harness: Harness,
    over: Partial<TurnRunInput> = {},
  ): Promise<Array<Record<string, unknown>>> => readSse(await runtime.run({
    harness,
    threadId: THREAD,
    messages: [userMessage("m1", "hello")],
    ctx: ctx(),
    workspace: testWorkspace(),
    models: unusedModels(),
    interactive: true,
    ...over,
  }));
  return { run };
}

describe("the render seam rides the wrapWorkspace slot (§1.6)", () => {
  it("a harness writing app.tsx puts the screen on the view channel", async () => {
    const f = fixture();
    const harness = defineHarness({
      name: "builder",
      async *run(turn) {
        yield { type: "status", label: "Writing the screen" };
        await turn.workspace.writeFile("/user/apps/app_7/app.tsx", SCREEN);
      },
    });
    const parts = await f.run(harness);
    const view = parts.find((part) => part.type === "data-vendo-view");
    expect(view).toBeDefined();
    expect(view).toMatchObject({ id: "vendo-view:app_7", data: { appId: "app_7" } });
  });

  it("a write the floor refuses puts nothing on screen", async () => {
    const f = fixture();
    const harness = defineHarness({
      name: "builder",
      async *run(turn) {
        await turn.workspace.writeFile("/user/apps/app_7/app.tsx", "half-written garba");
      },
    });
    const parts = await f.run(harness);
    expect(parts.some((part) => part.type === "data-vendo-view")).toBe(false);
  });

  it("a workspace tool edit lands on its own call, not at turn end (§3.5)", async () => {
    const workspace = testWorkspace();
    // Stands in for lane D's workspace_write: the tool stages, the runtime lands it.
    const f = fixture({
      tools: {
        workspace_write: {
          descriptor: readTool("workspace_write", "write"),
          execute: () => {
            void workspace.writeFile("/user/apps/app_9/app.tsx", SCREEN);
            return { written: true };
          },
        },
      },
    });
    const harness = defineHarness({
      name: "editor",
      async *run(turn) {
        await turn.tools.call("workspace_write", {});
        // The commit already happened, so the view is on the wire BEFORE the
        // harness says anything.
        expect(workspace.commits).toHaveLength(1);
        expect(workspace.commits[0]!.changed).toEqual(["/user/apps/app_9/app.tsx"]);
        yield { type: "text", delta: "Done." };
      },
    });
    const parts = await f.run(harness, { workspace });
    expect(parts.some((part) => part.type === "data-vendo-view")).toBe(true);
  });
});
