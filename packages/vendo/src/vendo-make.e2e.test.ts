/**
 * `vendo_make` — contract §3.1, walked through a real composed deployment.
 *
 * Two tools became one, and the tool stopped returning the app document. Both
 * halves of that are seams a stub could hide: a test that asks the apps registry
 * directly never learns whether the tool is PROJECTED to a caller, and a test
 * that asserts on a hand-built outcome never learns what actually crosses the
 * wire to a model. So this drives `vendo.handler` with a real store, real guard
 * and the real apps pack, and reads what a harness holding `turn.tools` sees.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_MAKE_TOOL,
  VENDO_TOOL_TITLES,
  makeReceiptSchema,
  type Principal,
  type ToolListing,
  type ToolResult,
} from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_make" };

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-make-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** Run one turn and hand back what the harness saw of `turn.tools`. */
async function turn(script: (tools: {
  list(): Promise<ToolListing[]>;
  call(name: string, args: unknown): Promise<ToolResult>;
}) => Promise<void>): Promise<void> {
  const store = await tempStore();
  const harness = defineHarness({
    name: "make-probe",
    async *run(t) {
      await script(t.tools as never);
      yield { type: "text", delta: "done" };
    },
  });
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    harness: harness as never,
  } as Parameters<typeof createVendo>[0]);
  const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thr_make",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "show me my spending" }] },
    }),
  }));
  await response.text();
  expect(response.status).toBe(200);
}

describe("vendo_make (contract §3.1)", () => {
  it("is the ONE app tool a caller is offered, and the old two are gone", async () => {
    let listed: ToolListing[] = [];
    await turn(async (tools) => { listed = await tools.list(); });

    const make = listed.find((listing) => listing.name === VENDO_MAKE_TOOL);
    expect(make, "the front door must be projected to every caller").toBeDefined();
    // The rename is only real if the old names are unreachable — a deployment
    // still offering them has two front doors, which is the thing being deleted.
    expect(listed.map((listing) => listing.name)).not.toContain("vendo_apps_create");
    expect(listed.map((listing) => listing.name)).not.toContain("vendo_apps_edit");
    // Risk grade `read`: making a screen is a document render. Actions INSIDE it
    // are graded and consented individually, at call time.
    expect(make!.risk).toBe("read");
    // A model is told the human label, never only the identifier (design §3).
    expect(make!.title).toBe(VENDO_TOOL_TITLES[VENDO_MAKE_TOOL]);
  });

  it("takes exactly request, app and context — request required", async () => {
    let listed: ToolListing[] = [];
    await turn(async (tools) => { listed = await tools.list(); });
    const schema = listed.find((listing) => listing.name === VENDO_MAKE_TOOL)!.inputSchema!;
    expect(Object.keys(schema["properties"] as object).sort()).toEqual(["app", "context", "request"]);
    expect(schema["required"]).toEqual(["request"]);
    // `additionalProperties: false` is what makes the three-param surface a
    // promise rather than a suggestion.
    expect(schema["additionalProperties"]).toBe(false);
  });

  it("refuses a call with no request, and one carrying an unknown property", async () => {
    const results: ToolResult[] = [];
    await turn(async (tools) => {
      results.push(await tools.call(VENDO_MAKE_TOOL, {}));
      results.push(await tools.call(VENDO_MAKE_TOOL, { request: "a chart", prompt: "a chart" }));
      results.push(await tools.call(VENDO_MAKE_TOOL, { request: "   " }));
    });
    for (const result of results) expect(result.status).toBe("error");
    expect(JSON.stringify(results)).toContain("request must be a non-empty string");
    expect(JSON.stringify(results)).toContain("unexpected input property: prompt");
  });

  it("answers with a receipt and nothing else — never the app document", async () => {
    const results: ToolResult[] = [];
    await turn(async (tools) => {
      // No model is configured for generation here, so this exercises the
      // failure path — which is exactly where a leak would be least noticed.
      results.push(await tools.call(VENDO_MAKE_TOOL, { request: "my spending this month" }));
    });
    const [result] = results;
    const serialized = JSON.stringify(result);
    // Whatever happened, the app DOCUMENT did not travel. These are the fields a
    // model must never be handed: a tree it could describe, island sources it
    // could retell, a machine reference it could name.
    for (const leaked of ["\"tree\"", "\"components\"", "\"componentTools\"", "\"machine\"", "\"snapshotRef\""]) {
      expect(serialized, `${leaked} reached the model`).not.toContain(leaked);
    }
    if (result!.status === "ok") {
      const receipt = makeReceiptSchema.parse(result!.output);
      expect(Object.keys(receipt).sort()).toEqual(["id", "say", "status", "title"]);
    }
  });
});
