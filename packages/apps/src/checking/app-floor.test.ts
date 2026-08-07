/**
 * `createAppFloor` — the checks floor as the PAINT SEAM calls it (blueprint §7.1).
 *
 * The hole this closes is worth restating, because it is what these tests are
 * for: the seam used to compile `app.vendo` with `compileWire(content)` and no
 * options at all, so a harness's own writes spoke a different dialect than the
 * conductor — inline tool references did not expand, and `bindingErrors` was
 * `[]` BY CONSTRUCTION. The floor was live for the conductor and structurally
 * dead for every other author, and every test passed the whole time, because
 * nothing ever asked the floor to compile.
 *
 * So these drive `compile` and `check` through the real seam, on real wire, and
 * assert the two things a structurally-dead floor cannot do: expand an inline
 * tool reference, and produce a binding error.
 */
import {
  compileWire,
  type Check,
  type NormalizedCatalog,
  type ShapeType,
} from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import type { FloorDependencies, HostToolInfo } from "./deps.js";
import { blocks, createAppFloor } from "./floor.js";

const tools: HostToolInfo[] = [{
  name: "host_listInvoices",
  description: "Open invoices",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
}];

const toolShapes: Record<string, ShapeType> = {
  host_listInvoices: {
    kind: "object",
    fields: {
      data: { kind: "array", items: { kind: "object", fields: { id: { kind: "string" } } } },
    },
  },
};

const catalog: NormalizedCatalog = [];

const floorDeps = (): FloorDependencies => ({ catalog, tools, toolShapes });

/** Inline tool reference — the form that compiled to nothing before the seam
 *  shared the dialect. */
const INLINE = '<App name="Invoices"><Stack gap={12}><Text text="Invoices" variant="heading"/><DataTable rows={host_listInvoices({}).data}/></Stack></App>';
/** Binds a field the shape card does not have. */
const BAD_BINDING = '<App name="Invoices"><DataTable rows={host_listInvoices({}).nope}/></App>';

describe("compile speaks the ONE dialect, not compileWire's defaults", () => {
  it("expands an inline tool reference into a query", async () => {
    const floor = createAppFloor({ deps: async () => floorDeps() });

    const compiled = await floor.compile(INLINE);

    // The bare-defaults compile this replaced produced no queries at all.
    expect(compiled.tree.queries?.map(({ tool }) => tool)).toEqual(["host_listInvoices"]);
  });

  it("is really different from a bare compileWire — the regression is observable", async () => {
    const bare = compileWire(INLINE);
    const floor = await createAppFloor({ deps: async () => floorDeps() }).compile(INLINE);

    expect(bare.tree.queries ?? []).toEqual([]);
    expect(floor.tree.queries ?? []).not.toEqual([]);
  });

  it("produces real binding errors instead of [] by construction", async () => {
    const floor = createAppFloor({ deps: async () => floorDeps() });

    const compiled = await floor.compile(BAD_BINDING);

    expect(compiled.bindingErrors.length).toBeGreaterThan(0);
    // The error names the binding that missed, not just "something is wrong".
    expect(compiled.bindingErrors.map(({ path }) => path).join(" ")).toContain("nope");
    expect(compiled.bindingErrors[0]?.tool).toBe("host_listInvoices");
  });

  it("carries the app's name through", async () => {
    const compiled = await createAppFloor({ deps: async () => floorDeps() }).compile(INLINE);
    expect(compiled.name).toBe("Invoices");
  });
});

describe("check runs the same layer create, edit and validate run", () => {
  it("says nothing about a good app", async () => {
    const floor = createAppFloor({ deps: async () => floorDeps() });
    const compiled = await floor.compile(INLINE);

    expect(await floor.check({ appId: "app_floor", compiled })).toEqual([]);
  });

  it("fires the host's own plugged checks over a harness's write", async () => {
    // The floor does not care who wrote the app — that is the whole point of
    // lifting it out of the generation pipeline.
    const hostCheck: Check = {
      name: "house-style",
      kind: "fact",
      run: async () => [{ severity: "block", where: "document", message: "no invoices on a Friday" }],
    };
    const floor = createAppFloor({ deps: async () => floorDeps(), checks: [hostCheck] });
    const compiled = await floor.compile(INLINE);

    const findings = await floor.check({ appId: "app_floor", compiled });

    expect(findings.map(({ message }) => message)).toContain("no invoices on a Friday");
    // Stamped with its provenance, so a host-check failure is distinguishable
    // from a built-in one at a waive point.
    expect(findings.find(({ message }) => message.includes("Friday"))?.check).toBe("house-style");
  });

  it("hands the checks the compiled app under the id the seam knows", async () => {
    let seenId: string | undefined;
    let seenRequest: string | undefined;
    const spy: Check = {
      name: "spy",
      kind: "fact",
      run: async ({ document, request }) => { seenId = document.id; seenRequest = request; return []; },
    };
    const floor = createAppFloor({ deps: async () => floorDeps(), checks: [spy] });

    await floor.check({ appId: "app_seam", compiled: await floor.compile(INLINE) });

    expect(seenId).toBe("app_seam");
    // A file write carries no user text; absence means "no carve-out", which is
    // the conservative direction.
    expect(seenRequest).toBe("");
  });

  it("carries generated components onto the document the checks read", async () => {
    const withIsland = '<App name="Islands"><Panel/><Island name="Panel">export default function Panel(){ return null; }</Island></App>';
    let componentNames: string[] = [];
    const spy: Check = {
      name: "spy",
      kind: "fact",
      run: async ({ document }) => { componentNames = Object.keys(document.components ?? {}); return []; },
    };
    const floor = createAppFloor({ deps: async () => floorDeps(), checks: [spy] });

    await floor.check({ appId: "app_islands", compiled: await floor.compile(withIsland) });

    expect(componentNames).toContain("Panel");
  });
});

describe("the host surface is resolved LAZILY and exactly once", () => {
  it("does not probe the host until the floor is actually used", () => {
    const deps = vi.fn(async () => floorDeps());

    createAppFloor({ deps });

    // A floor is constructed per turn and called per commit; building it probes
    // the host's read tools for shape cards.
    expect(deps).not.toHaveBeenCalled();
  });

  it("resolves once across many compiles and checks, so a turn cannot change its mind", async () => {
    const deps = vi.fn(async () => floorDeps());
    const floor = createAppFloor({ deps });

    const first = await floor.compile(INLINE);
    await floor.compile(BAD_BINDING);
    await floor.check({ appId: "app_once", compiled: first });

    expect(deps).toHaveBeenCalledTimes(1);
  });
});

describe("blocks — the findings that mean 'this must not reach a screen'", () => {
  it("keeps blocks and drops warns", () => {
    const findings = [
      { severity: "block" as const, message: "stops the app" },
      { severity: "warn" as const, message: "rides along" },
      { severity: "block" as const, message: "also stops it" },
    ];

    expect(blocks(findings).map(({ message }) => message)).toEqual(["stops the app", "also stops it"]);
  });

  it("answers empty for an all-warn set, so a warning never blocks a commit", () => {
    expect(blocks([{ severity: "warn", message: "rides along" }])).toEqual([]);
  });
});
