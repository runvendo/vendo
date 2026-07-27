/**
 * Vendo lane adapter (Task 4): drives an injected GenerationEngine-shaped
 * fake — zero model calls — and proves the LaneResult contract: ok carries
 * document + wire + ordered tapped events + durationMs; an engine throw
 * resolves (never rejects) to status:"failed" WITH the partial events
 * captured up to the throw.
 */
import { describe, expect, it } from "vitest";
import { VENDO_APP_FORMAT, VENDO_TREE_FORMAT } from "@vendoai/core";
import type { GeneratedAppDocument, GenerationDependencies, PipelineEvent } from "@vendoai/apps";
import { createVendoAdapter } from "./vendo";
import type { HostFixture } from "../runner/types";

const fixture: HostFixture = {
  name: "maple",
  catalog: [],
  tools: [{ name: "host_getProfile", description: "profile", risk: "read" }],
  shapes: { host_getProfile: { kind: "object", fields: { name: { kind: "string" } } } },
  theme: {},
  execute: async () => ({}),
};

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
});
