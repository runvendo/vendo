/**
 * The checks floor AT the paint seam — blueprint §7.1.
 *
 * THE HOLE THESE TESTS CLOSE. `viewForWrite` compiled `app.vendo` with
 * `compileWire(content)` and no options, so the seam spoke a different dialect
 * than every other compile of model wire in the codebase:
 *
 *  - a LYING binding (a `$path` naming a field the tool's shape does not have)
 *    produced `issues: []` and `bindingErrors: []` — measured, both empty — so
 *    "the engine's unshippable gate" was structurally dead on the files path and
 *    the app painted a promise it could not keep.
 *  - an app built on INLINE tool references had its binding DROPPED and its query
 *    never minted, and still painted: a `<Text>` with no props at all. That is
 *    the failure `apps/wire-options.ts` records — "live 2026-07-23: one recompile
 *    that lacked these options failed EVERY app built on inline references".
 *
 * Nothing here stubs either half. The floor is the REAL floor (`createAppFloor`,
 * the same `factChecks` + `createCheckingLayer` that `create`, `edit` and
 * `validate` run) and the write goes through the REAL workspace commit path,
 * because the repo's standing lesson is that a harness which mocks its
 * counterparty proves nothing: "the host-component previews shipped four times
 * with a green suite and a dead feature because the producer and the consumer
 * each mocked the other, so they could never disagree."
 */
import { createAppFloor } from "@vendoai/apps/internal";
import type { AppFloor, NormalizedCatalog, ShapeType, VendoViewPart } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapWorkspaceForRender } from "../src/render-seam.js";
import { testWorkspace } from "../src/test-doubles.test-util.js";

const APP = "app_1";
const APP_VENDO = `/user/apps/${APP}/app.vendo`;

const TOOL = "maple_spend_summary";

/** The host surface the floor measures against — one read tool whose response
 *  carries `total` and nothing else, which is what makes `grandTotal` a lie
 *  rather than a typo nobody can catch. */
const toolShapes: Readonly<Record<string, ShapeType>> = {
  [TOOL]: {
    kind: "object",
    fields: {
      total: { kind: "number" },
      rows: { kind: "array", items: { kind: "object", fields: { id: { kind: "string" } } } },
    },
  },
};

const catalog: NormalizedCatalog = [];

/**
 * A model that THROWS if anything calls it.
 *
 * The seam runs on every commit, so the floor it calls there must be the
 * deterministic half only — the AI reviewer spends a model call and belongs to
 * `validate`. This is how that stays true instead of being asserted in a comment.
 */
const forbiddenModel = new Proxy({}, {
  get: () => {
    throw new Error("the paint seam must never spend a model call");
  },
}) as unknown as LanguageModel;

const floor = (): AppFloor => createAppFloor({
  deps: async () => ({
    model: forbiddenModel,
    catalog,
    toolShapes,
    tools: [{ name: TOOL, description: "This month's spending", risk: "read" }],
  }),
});

/** The seam as the runtime builds it, with the real floor injected. */
function seam(options: { withFloor?: boolean } = {}) {
  const emitted: Array<{ id: string; part: VendoViewPart }> = [];
  const workspace = wrapWorkspaceForRender(testWorkspace(), {
    emit: (id, part) => emitted.push({ id, part }),
    ...(options.withFloor === false ? {} : { floor: floor() }),
  });
  /** Write then commit — what the runtime does for every hand that writes. */
  const save = async (content: string): Promise<void> => {
    await workspace.writeFile(APP_VENDO, content);
    await workspace.commit();
  };
  return { emitted, save, workspace };
}

const app = (body: string, name = "Spending"): string =>
  `<App name="${name}"><Query id="spend" tool="${TOOL}" />${body}</App>`;

/** Honest: `total` is a field the tool really returns. */
const HONEST = app(`<Stack><Text text={spend.total} /></Stack>`);
/** A LYING binding: `grandTotal` is absent from the tool's response shape, so the
 *  label promises a number the app can never show. */
const LYING = app(`<Stack><Text text={spend.grandTotal} /></Stack>`);

const painted = (emitted: Array<{ part: VendoViewPart }>): unknown =>
  emitted.at(-1)?.part.payload;

describe("a lying binding never reaches the user (proof bar 1)", () => {
  it("paints the honest app, refuses the lie, and paints again when it is restored", async () => {
    const { emitted, save } = seam();

    // 1. The honest app paints.
    await save(HONEST);
    expect(emitted).toHaveLength(1);
    const lastGood = painted(emitted);
    expect(JSON.stringify(lastGood)).toContain("/spend/total");

    // 2. The lie lands in the store and emits NOTHING. The last good view stays
    //    on screen — the seam's own mechanism, not a new failure channel.
    await save(LYING);
    expect(emitted).toHaveLength(1);
    expect(painted(emitted)).toEqual(lastGood);

    // 3. Restore the binding and it paints.
    await save(HONEST);
    expect(emitted).toHaveLength(2);
    expect(JSON.stringify(painted(emitted))).toContain("/spend/total");
  });

  it("still LANDS the lying write — the floor refuses the paint, never the commit", async () => {
    const { save, workspace } = seam();
    await save(LYING);
    // The brokenness reaches the harness through `validate`, never the user, so
    // the bytes must be on disk for it to read back and repair.
    await expect(workspace.readFile(APP_VENDO)).resolves.toBe(LYING);
  });

  it("is invisible without the floor — which is exactly what shipped", async () => {
    // The counter-proof: the SAME lie, the same real commit path, no floor. It
    // paints. This is the state of the files path before this change, and it is
    // why the guard above cannot be satisfied by the compiler alone.
    const { emitted, save } = seam({ withFloor: false });
    await save(LYING);
    expect(emitted).toHaveLength(1);
    expect(JSON.stringify(painted(emitted))).toContain("/spend/grandTotal");
  });
});

describe("the production dialect at the seam", () => {
  /** No `<Query>` declaration at all: the tool is CALLED inline, which is how the
   *  brain writes apps and what `inlineRefs` exists to expand. */
  const INLINE = `<App name="Spending"><Stack><Text text=${"{"}${TOOL}({}).total} /></Stack></App>`;

  it("expands an inline tool reference, so the app is not painted with its binding dropped", async () => {
    const { emitted, save } = seam();
    await save(INLINE);
    expect(emitted).toHaveLength(1);
    const payload = painted(emitted) as { nodes: Array<{ component: string; props?: Record<string, unknown> }>; queries?: unknown[] };
    // The query the reference minted, and the binding it resolved to.
    expect(payload.queries).toEqual([{ name: "mapleSpendSummary", tool: TOOL, input: {} }]);
    const text = payload.nodes.find((node) => node.component === "Text");
    expect(text?.props?.["text"]).toEqual({ $path: "/mapleSpendSummary/total" });
  });

  it("without the options that binding VANISHES and the app paints anyway", async () => {
    // The recorded regression, reproduced: bare `compileWire` cannot see an
    // inline reference, so it drops the prop and mints no query — and the tree
    // still has children, so the seam's `renders()` gate waves it through. A
    // <Text> with no props is the blank value the live failure showed.
    const { emitted, save } = seam({ withFloor: false });
    await save(INLINE);
    expect(emitted).toHaveLength(1);
    const payload = painted(emitted) as { nodes: Array<{ component: string; props?: Record<string, unknown> }>; queries?: unknown[] };
    expect(payload.queries).toBeUndefined();
    expect(payload.nodes.find((node) => node.component === "Text")?.props).toBeUndefined();
  });
});

/**
 * All SEVEN deterministic fact checks, landing at the seam — §7.1 item 2.
 *
 * One case per check, and each asserts the same three things: the honest app is on
 * screen first, the bad write emits NOTHING so that view stays, and the operator's
 * log names THE CHECK that refused. The last part is what makes this a test of the
 * floor rather than of the compiler — six of these seven wires compile perfectly
 * cleanly (only `bindings-fit` also raises a compile issue), so without the floor
 * every one of them would paint.
 */
describe("the seven fact checks all reach the seam", () => {
  const refusals = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** One wire per check, with the exact finding each is expected to produce. */
  const cases: ReadonlyArray<{ check: string; why: string; wire: string }> = [
    {
      check: "document",
      why: "the app's name is its display title, not the ask echoed back at length",
      wire: app(`<Stack><Text text={spend.total} /></Stack>`, "x".repeat(60)),
    },
    {
      check: "tools-exist",
      why: "a query naming a tool the host has not got",
      wire: `<App name="Spending"><Query id="spend" tool="nope_notATool" /><Stack><Text text={spend.total} /></Stack></App>`,
    },
    {
      check: "components-exist",
      why: "a prop name the renderer silently drops — the valid-table-empty-rows class",
      wire: app(`<Stack><DataTable data={spend.rows} /></Stack>`),
    },
    {
      check: "bindings-fit",
      why: "a $path reaching a field the tool's shape does not expose",
      wire: LYING,
    },
    {
      check: "expressions-compute",
      why: "a computed value over a field that is not there — a blank stat, not a crash",
      wire: app(`<Stack><Text text={spend.nope * 2} /></Stack>`),
    },
    {
      check: "query-inputs-literal",
      why: "a query input is executed as literal JSON, so a binding inside it never resolves",
      wire: `<App name="Spending"><Query id="spend" tool="${TOOL}" /><Query id="dep" tool="${TOOL}" input={{id: spend.total}} /><Stack><Text text={dep.total} /></Stack></App>`,
    },
    {
      check: "no-string-interpolation",
      why: "the wire has no string interpolation, so the braces render literally",
      wire: app(`<Stack><Text text="Total: {spend.total}" /></Stack>`),
    },
  ];

  for (const { check, why, wire } of cases) {
    it(`${check} blocks the paint — ${why}`, async () => {
      const logged = refusals();
      const { emitted, save } = seam();

      await save(HONEST);
      expect(emitted).toHaveLength(1);
      const lastGood = painted(emitted);

      await save(wire);
      // Nothing painted, and the last good view is untouched.
      expect(emitted).toHaveLength(1);
      expect(painted(emitted)).toEqual(lastGood);
      // THIS check is why — not merely "something refused".
      expect(logged.mock.calls.map(String).join("\n")).toContain(`[${check}]`);
    });

    it(`${check} paints without the floor — which is the hole`, async () => {
      // The counter-proof, per check: the same wire, the same real commit path, no
      // floor. It paints. Six of these seven compile with no issue at all, so the
      // compiler was never going to catch them.
      const { emitted, save } = seam({ withFloor: false });
      await save(wire);
      expect(emitted).toHaveLength(1);
    });
  }
});
