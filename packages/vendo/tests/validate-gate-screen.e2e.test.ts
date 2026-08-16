/**
 * THE BUILDER'S VALIDATE GATE, ON A SCREEN THAT PAINTS.
 *
 * `validateWrittenApps` is what a `claudeCode()` turn runs over the files the model
 * wrote (`packages/harnesses/src/claude-code/index.ts`, the artifact path). It used
 * to hand EVERY app document to a door that compiled what it was given as markup,
 * so an `app.tsx` that compiled, type-checked, ran in the sealed VM and PAINTED
 * came back "expected a single <App> element", and a builder that obeyed the
 * feedback rewrote a working screen into markup.
 *
 * So this walks a REAL composed deployment — real store, real guard, real apps
 * pack, the real render seam, the real component gauntlet, the real `validate`
 * verb — writes the screen with a harness's own hands exactly as the artifact path
 * does, and asks the REAL gate what it makes of a screen the seam has just
 * painted. Only the model is scripted, because what is measured is the doors.
 *
 * The one that must be able to fail: stop the gate reaching the ROW-SCOPED
 * `validate({appId})` in `packages/apps/src/server/generation/validate-gate.ts`
 * and this goes red — either with a finding about a screen that paints, or with
 * the silence of a gate that judged nothing at all.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  paintedIn,
  SCREEN_FILE,
  validateWrittenApps,
  type AppValidationFailure,
} from "@vendoai/apps";
import type { AppId, Principal } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_validate_gate" };

const APP_ID = "app_written_screen" as AppId;
const SCREEN_PATH = `/user/apps/${APP_ID}/${SCREEN_FILE}`;

/** The smallest screen the gauntlet passes and the seam paints. */
const SPENDING = `import { Stack, Text } from "@vendo/screen";

export default function Spending() {
  return (
    <Stack gap={12}>
      <Text text="This month" variant="heading" />
    </Stack>
  );
}
`;

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-validate-gate-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

describe("the validate gate judges a written app by what it IS", () => {
  it("a component screen that paints passes the gate, through the door that reads a screen", async () => {
    const store = await tempStore();
    /** The reviewer is the only thing that thinks here — the harness below never
     *  asks a model anything — so this counts the calls the ROW-SCOPED door makes.
     *  It answers clean through its own strict tool call, which is what keeps the
     *  gauntlet rather than a provider's mood the thing under test. */
    let reviewerCalls = 0;
    const model = {
      specificationVersion: "v2",
      provider: "vendo-validate-gate",
      modelId: "vendo-validate-gate-v1",
      supportedUrls: {},
      async doGenerate() {
        reviewerCalls += 1;
        return {
          content: [{
            type: "tool-call" as const,
            toolCallId: "call_report_findings",
            toolName: "report_findings",
            input: JSON.stringify({ findings: [] }),
          }],
          finishReason: "tool-calls" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    } as unknown as LanguageModel;

    let painted: boolean | undefined;
    let failures: readonly AppValidationFailure[] | undefined;
    const harness = defineHarness({
      name: "validate-gate-probe",
      async *run(turn) {
        // The artifact path's own two steps: land the file the model wrote, then
        // gate what landed. The commit IS the paint (§1.6).
        await turn.workspace.writeFile(SCREEN_PATH, SPENDING);
        const committed = await turn.workspace.commit({ message: "the screen" });
        painted = paintedIn(committed)?.includes(APP_ID) === true;
        failures = await validateWrittenApps({
          tools: turn.tools,
          paths: [SCREEN_PATH],
          // What `claudeCode()` passes at the turn boundary.
          review: true,
        });
        yield { type: "text", delta: "ok" };
      },
    });
    const vendo = createVendo({
      models: { default: model },
      principal: async () => principal,
      store,
      harness: harness as never,
    } as Parameters<typeof createVendo>[0]);

    const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thr_validate_gate",
        message: { id: "m1", role: "user", parts: [{ type: "text", text: "show me my spending" }] },
      }),
    }));
    await response.text();
    expect(response.status).toBe(200);

    // The real floor really painted it: the gauntlet's five stages passed and the
    // seam put the screen on the wire. Anything the gate says now is about a screen
    // the person can see.
    expect(painted).toBe(true);
    // THE BUG. The wire door answered this screen with "expected a single <App>
    // element", and one round later the builder had replaced it with markup.
    expect(failures).toEqual([]);
    // …and it was not silence that passed it: the screen went to the door that
    // reads a stored screen, which runs the gauntlet AND the one judging call.
    expect(reviewerCalls).toBe(1);
  }, 120_000);
});
