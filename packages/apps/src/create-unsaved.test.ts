import type { RunContext, ToolRegistry, VendoViewPart } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createAgentTools } from "./agent-tools.js";
import { createApps } from "./index.js";
import { basicLanguageModel, guardFixture, memoryStore } from "./testing/index.js";

/**
 * Regression guard for the LIVE deployed-Maple failure (2026-07-27): the
 * prompt generated cleanly (`attempt=0 valid=true`) and the user still got
 * nothing usable — a half-painted donut and two more cards frozen on
 * "Building your view…", then the agent apologizing with a plain text table.
 *
 * Cause: the final `emit(finalTree)` was sequenced AFTER `apps.put`, so a
 * store that refused the write (the Cloud console was 503ing every
 * `vendo_apps` write) skipped the emit entirely. Every card kept whatever
 * mid-stream payload it last received, forever, and the create tool answered
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

describe("a create the store refuses to persist", () => {
  it("still puts the finished view on screen and resolves with the document", async () => {
    const runtime = createApps({
      store: storeRefusingAppWrites(),
      guard: guardFixture(),
      tools,
      catalog: [],
      model: basicLanguageModel(),
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
    // of "Building your view…". This is the assertion the live bug failed.
    expect(settledParts(parts)).toHaveLength(1);
    expect(settledParts(parts)[0]?.appId).toBe(app.id);
    // And the caller is told, exactly once, that it is view-only.
    expect(unsaved).toHaveLength(1);
    expect(unsaved[0]).toContain("Store request failed.");
  });

  it("reads to the agent as success with an honest note — never a failure it would retry", async () => {
    const runtime = createApps({
      store: storeRefusingAppWrites(),
      guard: guardFixture(),
      tools,
      catalog: [],
      model: basicLanguageModel(),
    });
    const agentTools = createAgentTools(runtime, {
      data: {} as never,
      requireOwned: async () => { throw new Error("unused"); },
    });

    const outcome = await agentTools.execute(
      { id: "call_1", tool: "vendo_apps_create", args: { prompt: "Show my spending by category" } },
      ctx,
    );

    expect(outcome.status).toBe("ok");
    const output = (outcome as { output: Record<string, unknown> }).output;
    const note = output.unsaved as { savedToAppsList?: boolean; guidance?: string };
    expect(note?.savedToAppsList).toBe(false);
    // The guidance is what stops the three-cards-per-prompt loop.
    expect(note?.guidance).toMatch(/do NOT call vendo_apps_create again/);
  });

  it("says nothing extra when the store is healthy (the note is failure-only)", async () => {
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools,
      catalog: [],
      model: basicLanguageModel(),
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
