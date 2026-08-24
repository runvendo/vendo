import {
  type RunContext,
  type ToolRegistry,
  type VendoViewPart,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps, type AppsRuntime } from "../src/server/index.js";
import { authoringAssembler } from "../src/server/testing/screen-assembler.js";
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
 * store that refused the write skipped the emit entirely.
 *
 * The contract now: a storage fault costs the user the SAVE, never the VIEW —
 * and on a healthy store the caller hears nothing about saving at all.
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

describe("a create the store refuses to persist", () => {
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
