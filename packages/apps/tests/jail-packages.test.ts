import {
  VENDO_APP_FORMAT,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createApps } from "../src/server/index.js";
import { stripServerAuthoritativeFields } from "../src/server/persistence/open.js";
import { pinComponentName, type PinBaseline } from "../src/server/remix/pins.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { scriptedLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";

/**
 * The venue wall for CDN package loading.
 *
 * The jail renders a remix fork inside a CUSTOMER's own page, so
 * `JailFurnishing.packages` — the field that lets a jail fetch scripts from a
 * third party — must not exist on that path in either direction: the runtime
 * cannot produce one, and a document cannot claim one.
 */
const tools: ToolRegistry = {
  async descriptors() {
    return [];
  },
  async execute() {
    return { status: "error", error: { code: "not-found", message: "No fixture tools" } };
  },
};

const owner: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const slot = "spending-donut";

/** A baseline carrying the field, exactly as a captured host-component record
 *  does — so this asserts the runtime's field list, not the absence of input. */
const baseline = {
  slot,
  source: "export default function Donut() { return <b>host</b>; }",
  hash: "sha256:donut-base",
  exportable: true,
  capturedAt: "2026-08-01T12:00:00.000Z",
  sourceImports: { "./helper": "src/helper.ts" },
  subSources: { "src/helper.ts": { source: "export const helper = 1;", imports: {} } },
  packages: { recharts: "recharts@3.9.2" },
} as PinBaseline;

const doc = (): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_jail_packages",
  name: "Donut remix",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["fork"] },
      { id: "fork", component: pinComponentName(slot), source: "generated" },
    ],
  },
  pins: [{ slot, base: "sha256:donut-base" }],
  components: { [pinComponentName(slot)]: "export default function Fork() { return <b>fork</b>; }" },
});

describe("CDN package loading never reaches the production venue", () => {
  it("a pin furnishing carries no packages, even when the baseline does", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      pinBaselines: [baseline],
      model: scriptedLanguageModel(() => "<Edit></Edit>"),
    });
    const app = doc();
    await seedAppRow(store, app, owner.principal.subject);

    const surface = await runtime.open(app.id, owner);
    if (surface.kind !== "tree") throw new Error("expected tree surface");
    const furnishing = (surface.payload as {
      furnishings?: Record<string, Record<string, unknown>>;
    }).furnishings?.[pinComponentName(slot)];
    // Everything a fork legitimately needs still travels…
    expect(furnishing?.sourceImports).toEqual({ "./helper": "src/helper.ts" });
    expect(furnishing?.subSources).toBeDefined();
    // …and the one thing that would reach a CDN does not.
    expect(furnishing?.packages).toBeUndefined();
  });

  it("strips a forged packages field off any stored or imported tree", () => {
    const payload = {
      inClient: { granted: true },
      furnishings: {
        Forged: {
          sourceImports: { "./x": "src/x.ts" },
          sampleProps: { total: 1 },
          packages: { recharts: "recharts@3.9.2" },
        },
        Plain: { sourceImports: {} },
      },
    };
    stripServerAuthoritativeFields(payload);
    expect(payload.inClient).toBeUndefined();
    expect(payload.furnishings.Forged).toEqual({
      sourceImports: { "./x": "src/x.ts" },
      sampleProps: { total: 1 },
    });
    expect(payload.furnishings.Plain).toEqual({ sourceImports: {} });
  });

  it("survives a payload with no furnishings at all", () => {
    expect(stripServerAuthoritativeFields({ furnishings: null })).toEqual({ furnishings: null });
    expect(stripServerAuthoritativeFields({})).toEqual({});
  });
});
