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

  // REMOVED by the consent slice (S3): `vendo_make` no longer calls `create` on
  // an escalation, so the view-only caveat this pinned through the agent bridge
  // has no producer left on that route. `create`'s own `onUnsaved` signal —
  // the thing this file is about — is covered above and below.
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
