/**
 * Vendo lane adapter (Task 4): drives an injected GenerationEngine-shaped
 * fake — zero model calls — and proves the LaneResult contract: ok carries
 * document + wire + ordered tapped events + durationMs; an engine throw
 * resolves (never rejects) to status:"failed" WITH the partial events
 * captured up to the throw.
 */
import { describe, expect, it } from "vitest";
import { VendoError, VENDO_APP_FORMAT, VENDO_TREE_FORMAT } from "@vendoai/core";
import type { GeneratedAppDocument, GenerationDependencies, PipelineEvent } from "@vendoai/apps";
import { createVendoAdapter, failureReason, transformModelParams, type ModelCallParams } from "./vendo";
import { MAX_OUTPUT_TOKENS, PRODUCTION_MODEL, findModel, type BenchModel } from "../runner/models";
import type { HostFixture } from "../runner/types";
import { stubHostFixture } from "../fixtures/stub";

const fixture: HostFixture = stubHostFixture("maple", {
  catalog: [],
  tools: [{ name: "host_getProfile", description: "profile", risk: "read" }],
  shapes: { host_getProfile: { kind: "object", fields: { name: { kind: "string" } } } },
});

const generatedDocument: GeneratedAppDocument = {
  format: VENDO_APP_FORMAT,
  name: "Profile card",
  ui: "tree",
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["owner"] },
      { id: "owner", component: "Stat", props: { label: "Owner", value: { $path: "/profile/name" } } },
    ],
    queries: [{ name: "profile", tool: "host_getProfile" }],
  },
};

const events: PipelineEvent[] = [
  { stage: "full", attempt: 1, valid: false, ms: 10 },
  { stage: "repair", rounds: 1, repaired: true, noValidFix: 0, ms: 20 },
  { stage: "full", attempt: 2, valid: true, ms: 30 },
];

const fakeModel = { modelId: "fake" } as unknown as GenerationDependencies["model"];

describe("vendo lane adapter", () => {
  it("returns document, wire, and the tapped events in order", async () => {
    const seen: { prompt?: string; deps?: GenerationDependencies } = {};
    const adapter = createVendoAdapter({
      model: fakeModel,
      engine: {
        create: async (input, deps) => {
          seen.prompt = input.prompt;
          seen.deps = deps;
          for (const event of events) deps.onPipeline?.(event);
          return generatedDocument;
        },
      },
    });

    const result = await adapter.generate("show my profile", fixture);
    if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.document?.id).toMatch(/^app_/);
    expect(result.document?.tree).toEqual(generatedDocument.tree);
    expect(result.events).toEqual(events);
    expect(typeof result.durationMs).toBe("number");
    expect(result.startedAt).toBeGreaterThan(0);
    // The canonical printed wire of the returned tree.
    expect(result.wire).toContain("Stat");
    expect(result.wire).toContain("host_getProfile");

    // The engine saw the fixture surface, production-default pipeline config.
    expect(seen.prompt).toBe("show my profile");
    expect(seen.deps?.catalog).toBe(fixture.catalog);
    expect(seen.deps?.tools).toBe(fixture.tools);
    expect(seen.deps?.toolShapes).toBe(fixture.shapes);
    expect(seen.deps?.pipeline).toBeUndefined();
  });

  it("never throws: an engine crash resolves to failed with the partial events", async () => {
    const adapter = createVendoAdapter({
      model: fakeModel,
      engine: {
        create: async (_input, deps) => {
          deps.onPipeline?.(events[0] as PipelineEvent);
          throw new Error("model exploded mid-pipeline");
        },
      },
    });

    const result = await adapter.generate("boom", fixture);
    if (result.status !== "failed") throw new Error(`expected failed, got ${JSON.stringify(result)}`);
    expect(result.error).toContain("model exploded mid-pipeline");
    expect(result.events).toEqual([events[0]]);
    expect(typeof result.durationMs).toBe("number");
  });

  /** A generation failure's message is the generic "model could not produce a
   *  valid app"; the reason rides the VendoError detail and the per-attempt
   *  events. Both must survive into the LaneResult or a failed run in the
   *  cockpit is unreadable. */
  it("a validation failure is self-explanatory: the issues ride the error AND the events", async () => {
    const issues = [
      'tree root "root" renders an empty layout; keep at least one attached, visible node',
      "the app has a title and no content",
    ];
    const invalidAttempt: PipelineEvent = { stage: "full", attempt: 0, valid: false, ms: 6984, issues };
    const adapter = createVendoAdapter({
      model: fakeModel,
      engine: {
        create: async (_input, deps) => {
          deps.onPipeline?.(invalidAttempt);
          throw new VendoError("validation", "model could not produce a valid app", issues);
        },
      },
    });

    const result = await adapter.generate("create a component with a big Y", fixture);
    if (result.status !== "failed") throw new Error(`expected failed, got ${JSON.stringify(result)}`);
    expect(result.error).toContain("model could not produce a valid app");
    for (const issue of issues) expect(result.error).toContain(issue);
    expect(result.events).toEqual([invalidAttempt]);
  });
});

describe("failureReason", () => {
  it("passes a plain error through untouched", () => {
    expect(failureReason(new Error("api down"))).toBe("api down");
    expect(failureReason("not an error")).toBe("not an error");
  });

  it("ignores a non-string-array detail", () => {
    expect(failureReason(new VendoError("blocked", "nope", { why: "policy" }))).toBe("nope");
  });
});

/** RunRequest.model → the adapter. No model calls: `createModel` is the seam
 *  that captures the id, and the params rewrite is a pure function. */
describe("vendo lane model controls", () => {
  const okEngine = { create: async () => generatedDocument };

  function adapterCapturingId(): { seen: string[]; adapter: ReturnType<typeof createVendoAdapter> } {
    const seen: string[] = [];
    return {
      seen,
      adapter: createVendoAdapter({
        engine: okEngine,
        createModel: (id) => {
          seen.push(id);
          return fakeModel;
        },
      }),
    };
  }

  it("no model on the request → the engine's production default, untouched", async () => {
    const { seen, adapter } = adapterCapturingId();
    const result = await adapter.generate("hi", fixture);
    expect(result.status).toBe("ok");
    expect(seen).toEqual([PRODUCTION_MODEL.id]);
  });

  it("threads the chosen model id into the provider call", async () => {
    const { seen, adapter } = adapterCapturingId();
    const result = await adapter.generate("hi", fixture, { model: { id: "claude-opus-5" } });
    expect(result.status).toBe("ok");
    expect(seen).toEqual(["claude-opus-5"]);
  });

  it("fails the lane (never silently drops) on a setting the model rejects", async () => {
    const { adapter } = adapterCapturingId();
    const result = await adapter.generate("hi", fixture, {
      model: { id: "claude-opus-5", temperature: 0.7 },
    });
    if (result.status !== "failed") throw new Error(`expected failed, got ${result.status}`);
    expect(result.error).toContain("does not accept a temperature");
  });

  /** What the engine actually sends: temperature hardcoded to 0, nothing else. */
  const engineParams = (): ModelCallParams => ({ temperature: 0 });

  const opus5 = findModel("claude-opus-5") as BenchModel;
  const sonnet46 = findModel("claude-sonnet-4-6") as BenchModel;

  it("strips the engine's hardcoded temperature for models that reject it", () => {
    // The engine sends temperature: 0 at every call site; the Claude 5 line
    // 400s on any temperature, so leaving it would break every run.
    const out = transformModelParams(engineParams(), { id: opus5.id }, opus5);
    expect("temperature" in out).toBe(false);
    expect(out.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("applies temperature and thinking budget on models that take them", () => {
    const out = transformModelParams(
      engineParams(),
      { id: sonnet46.id, thinkingBudget: 4096 },
      sonnet46,
    );
    expect(out.providerOptions?.anthropic).toEqual({
      thinking: { type: "enabled", budgetTokens: 4096 },
    });
    // Anthropic forbids temperature alongside extended thinking.
    expect("temperature" in out).toBe(false);

    const warm = transformModelParams(engineParams(), { id: sonnet46.id, temperature: 0.8 }, sonnet46);
    expect(warm.temperature).toBe(0.8);
    expect(warm.providerOptions).toBeUndefined();
  });

  it("maps thinking effort onto the provider's output_config.effort seam", () => {
    const out = transformModelParams(engineParams(), { id: opus5.id, effort: "high" }, opus5);
    expect(out.providerOptions?.anthropic).toEqual({ effort: "high" });
  });
});
