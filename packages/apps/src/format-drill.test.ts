import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  type AppDocument,
  type RunContext,
  type ToolRegistry,
  type UIPayload,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import {
  bindTools,
  guardFixture,
  memoryStore,
  seedAppRow,
} from "./testing/index.js";

/**
 * FORMAT-EVOLUTION FIRE DRILL — the APPS seam (06-apps §1; 01-core §8).
 *
 * A throwaway second UI format proves the runtime passes an instant-path payload
 * through `open()` byte-identical (deep-equal), keyed only on its tag — apps must
 * not body-sniff payload internals; "the tag owns everything past itself." It
 * also proves stored records of the OLD (v0 tree) format keep opening unchanged
 * once a future format exists, and that the `vendo_apps_open` agent-tool path
 * carries the same surface.
 *
 * The drill tag lives ONLY in this test file; it is never a registered format.
 */
const DRILL_FORMAT = "vendo/tree@2-drill";

const ctx = (subject = "user_ada"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

/** A non-tree drill payload — no root/nodes; a `root` that names nothing so v1
 *  validation WOULD fail. open() must pass it through, not sniff it. */
const drillPayload = (): UIPayload => ({
  formatVersion: DRILL_FORMAT,
  root: "does-not-exist",
  blocks: [
    { heading: "Quarterly revenue", body: "$4,200 across 3 invoices" },
    { heading: "Next step", body: "Send the reminder" },
  ],
});

const drillDoc = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Drill app",
  tree: drillPayload(),
});

const v1Doc = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "V1 app",
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["title"] },
      { id: "title", component: "Text", props: { text: "Instant invoice" } },
    ],
    data: { invoice: { total: 4200 } },
  },
});

const emptyTools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

const runtimeWith = () => {
  const store = memoryStore();
  const guard = guardFixture();
  const runtime = createApps({ store, guard, tools: bindTools(guard, emptyTools), catalog: [] });
  return { store, runtime };
};

describe("format-evolution fire drill — apps passes the tag through unchanged", () => {
  it("loads a stored drill-tagged document (validateAppDocument accepts the tag)", async () => {
    const { store, runtime } = runtimeWith();
    await seedAppRow(store, drillDoc("app_drill_open"), "user_ada");

    // get() runs the doc back through validateAppDocument on load — no rejection.
    const loaded = await runtime.get("app_drill_open", ctx());
    expect(loaded).not.toBeNull();
    expect(loaded?.tree).toEqual(drillPayload());
  });

  it("open() returns a tree surface whose payload is byte-identical to the drill payload", async () => {
    const { store, runtime } = runtimeWith();
    await seedAppRow(store, drillDoc("app_drill_open2"), "user_ada");

    const surface = await runtime.open("app_drill_open2", ctx());
    expect(surface.kind).toBe("tree");
    if (surface.kind !== "tree") throw new Error("expected a tree surface");
    // Deep-equal, and untouched: no query resolution, no data mutation, blocks intact.
    expect(surface.payload).toEqual(drillPayload());
    expect(surface.payload.formatVersion).toBe(DRILL_FORMAT);
  });

  it("does not body-sniff: an unresolvable v1 shape under the drill tag still opens", async () => {
    // drillPayload().root names no node — a guaranteed v1 provision failure. If
    // open() validated it as a tree it would throw; under the tag it is opaque.
    const { store, runtime } = runtimeWith();
    await seedAppRow(store, drillDoc("app_drill_opaque"), "user_ada");

    const surface = await runtime.open("app_drill_opaque", ctx());
    if (surface.kind !== "tree") throw new Error("expected a tree surface");
    expect(surface.payload).toEqual(drillPayload());
  });

  it("keeps opening a stored v0 (tree) record identically after the drill format exists", async () => {
    const { store, runtime } = runtimeWith();
    // Both formats coexist in the same store, as a live runtime would hold them.
    await seedAppRow(store, drillDoc("app_drill_coexist"), "user_ada");
    await seedAppRow(store, v1Doc("app_v1_coexist"), "user_ada");

    const surface = await runtime.open("app_v1_coexist", ctx());
    if (surface.kind !== "tree") throw new Error("expected a tree surface");
    expect(surface.payload.formatVersion).toBe(VENDO_TREE_FORMAT);
    // The v0 record resolves its queries/data exactly as before — stored records stay alive.
    expect((surface.payload as { root: string }).root).toBe("root");
    expect((surface.payload as { data?: unknown }).data).toEqual({ invoice: { total: 4200 } });
  });

  it("carries the drill surface through the vendo_apps_open agent tool path", async () => {
    const { store, runtime } = runtimeWith();
    await seedAppRow(store, drillDoc("app_drill_agent"), "user_ada");

    const agentTools = runtime.agentTools();
    const outcome = await agentTools.execute(
      { id: "call_open", tool: "vendo_apps_open", args: { appId: "app_drill_agent" } },
      ctx(),
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    const surface = outcome.output as { kind: string; payload: UIPayload };
    expect(surface.kind).toBe("tree");
    expect(surface.payload).toEqual(drillPayload());
  });
});
