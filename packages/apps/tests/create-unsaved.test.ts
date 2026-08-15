import {
  type RunContext,
  type ToolRegistry,
  type UIPayload,
  type VendoViewPart,
} from "@vendoai/core";
import {
  type ScreenAssembler,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createAgentTools } from "../src/server/doors/agent-tools.js";
import { createApps, type AppsRuntime } from "../src/server/index.js";
import { assembleTree } from "../src/server/runtime/runtime.js";
import { authoringAssembler } from "../src/server/testing/screen-assembler.js";
import { fakeBoxSandbox } from "../src/server/testing/fake-box.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel } from "../src/server/testing/scripted-model.js";

/**
 * Regression guard for the LIVE deployed-Maple failure (2026-07-27): the
 * prompt generated cleanly (`attempt=0 valid=true`) and the user still got
 * nothing usable — a half-painted donut and two more cards frozen on
 * "Building your view…", then the agent apologizing with a plain text table.
 *
 * Cause: the final `emit(finalTree)` was sequenced AFTER `apps.put`, so a
 * store that refused the write (the Cloud console was 503ing every
 * `vendo_apps` write) skipped the emit entirely. Every card kept whatever
 * mid-stream payload it last received, forever, and the make tool answered
 * the agent with a bare error — which it "fixed" by building the app twice
 * more. Three cards, one prompt, nothing saved, nothing logged on the user
 * path.
 *
 * The contract now: a storage fault costs the user the SAVE, never the VIEW.
 */

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

/** A store whose vendo_apps writes fail the way the live console did. */
const storeRefusingAppWrites = (): ReturnType<typeof memoryStore> => {
  const store = memoryStore();
  const records = store.records.bind(store);
  return Object.assign(store, {
    records(collection: string) {
      const inner = records(collection);
      if (collection !== "vendo_apps") return inner;
      return Object.assign(Object.create(Object.getPrototypeOf(inner) ?? {}), inner, {
        async put() {
          throw Object.assign(new Error("Store request failed."), { code: "unavailable" });
        },
      });
    },
  }) as ReturnType<typeof memoryStore>;
};

const settledParts = (parts: VendoViewPart[]): VendoViewPart[] =>
  parts.filter((part) => (part.payload as { streaming?: boolean }).streaming !== true);

const SCREEN = `import { Stack, Text } from "@vendo/screen";

export default function Spending() {
  return (
    <Stack gap={12}>
      <Text text="This month" variant="heading" />
    </Stack>
  );
}
`;

/**
 * An escalating screen agent that painted something on `vendoViewStreamId(appId)`
 * before it asked for the builder. That paint is UPSTREAM of `create` — the door
 * itself paints nothing until the box has built something — so it is the one
 * thing a refused store must not be allowed to take away.
 */
const escalatingPainter: ScreenAssembler = {
  assemble: async (request) => {
    request.onView?.({
      type: "data-vendo-view",
      appId: request.appId,
      payload: assembleTree({
        tree: {
          root: "root",
          nodes: [{ id: "root", component: "Text", source: "generated", props: { text: "This month" } }],
        },
      }) as unknown as UIPayload,
    });
    return { kind: "escalate", why: "this needs a real build" };
  },
};

describe("a create the store refuses to persist", () => {
  it("still puts the finished view on screen and resolves with the document", async () => {
    // The one lane where a create can be unsaved and still resolve: the escalation
    // build (assembly's own save either lands a row or the build fails — see
    // screen-route.test.ts, "an `assembled` that left no ROW behind is not an app").
    const runtime = createApps({
      store: storeRefusingAppWrites(),
      guard: guardFixture(),
      tools,
      catalog: [],
      model: basicLanguageModel(),
      machine: { sandbox: fakeBoxSandbox(), buildEnv: () => ({ PORT: "8080" }), boxEditPollMs: 5 },
      screen: escalatingPainter,
    });
    const parts: VendoViewPart[] = [];
    const unsaved: string[] = [];

    const app = await runtime.create({
      prompt: "Show my spending by category",
      onView: (part) => parts.push(part),
      onUnsaved: (reason) => unsaved.push(reason),
    }, ctx);

    // The turn survives: the caller gets the real document, not a throw.
    expect(app.id).toMatch(/^app_/);
    // The card RESOLVES — a settled (non-streaming) part is what flips it out
    // of "Building your view…". This is the assertion the live bug failed, and a
    // refused store must not tear the painted view back down.
    expect(settledParts(parts)).toHaveLength(1);
    expect(settledParts(parts)[0]?.appId).toBe(app.id);
    // And the caller is told, exactly once, that it is view-only.
    expect(unsaved).toHaveLength(1);
    expect(unsaved[0]).toContain("Store request failed.");
  });

  it("reads to the agent as success with an honest note — never a failure it would retry", async () => {
    // Through the front door, which reaches `create` by ESCALATION: the screen
    // agent asks for the builder and this deployment has a sandbox to build in.
    // (It used to reach it by falling through from an unwired assembler; that
    // fall-through is gone, and an unwired assembler now fails loudly.)
    const escalating: ScreenAssembler = {
      assemble: async () => ({ kind: "escalate", why: "this needs a real build" }),
    };
    const runtime = createApps({
      store: storeRefusingAppWrites(),
      guard: guardFixture(),
      tools,
      catalog: [],
      model: basicLanguageModel(),
      machine: { sandbox: fakeBoxSandbox(), buildEnv: () => ({ PORT: "8080" }), boxEditPollMs: 5 },
      screen: escalating,
    });
    const agentTools = createAgentTools(runtime, {
      data: {} as never,
      requireOwned: async () => { throw new Error("unused"); },
      claimSlot: async () => { throw new Error("unused"); },
      markUnbuilt: async () => { throw new Error("unused"); },
      screen: escalating,
    });

    const outcome = await agentTools.execute(
      { id: "call_1", tool: "vendo_make", args: { request: "Show my spending by category" } },
      ctx,
    );

    expect(outcome.status).toBe("ok");
    const output = (outcome as { output: Record<string, unknown> }).output;
    // The receipt reads "ready", because the screen IS on the user's page. The
    // caveat rides `say` — one true sentence with nothing in it to react to,
    // which is what stops the three-cards-per-prompt loop. A "failed" status
    // here, or a structured note to reason about, is an invitation to rebuild.
    expect(output.status).toBe("ready");
    expect(output.say).toMatch(/on your screen/i);
    expect(output.say).toMatch(/couldn't save it to your apps/i);
    // Contract §3.1 — four fields of words, and no document among them.
    expect(Object.keys(output).sort()).toEqual(["id", "say", "status", "title"]);
  });

  it("says nothing extra when the store is healthy (the note is failure-only)", async () => {
    let runtime: AppsRuntime;
    runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools,
      catalog: [],
      model: basicLanguageModel(),
      screen: authoringAssembler(() => runtime, SCREEN),
    });
    const parts: VendoViewPart[] = [];
    const unsaved: string[] = [];

    const app = await runtime.create({
      prompt: "Show my spending by category",
      onView: (part) => parts.push(part),
      onUnsaved: (reason) => unsaved.push(reason),
    }, ctx);

    expect(unsaved).toEqual([]);
    expect(settledParts(parts)).toHaveLength(1);
    // Healthy path still persists — the resilience arm must not have replaced
    // the save with a shrug.
    expect(await runtime.get(app.id, ctx)).toMatchObject({ id: app.id });
  });
});
