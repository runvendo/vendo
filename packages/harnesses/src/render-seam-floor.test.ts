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
import { describe, expect, it } from "vitest";
import { wrapWorkspaceForRender } from "./render-seam.js";
import { testWorkspace } from "./test-doubles.test-util.js";

const APP = "app_1";
const APP_VENDO = `/user/apps/${APP}/app.vendo`;

const TOOL = "maple_spend_summary";

/** The host surface the floor measures against — one read tool whose response
 *  carries `total` and nothing else, which is what makes `grandTotal` a lie
 *  rather than a typo nobody can catch. */
const toolShapes: Readonly<Record<string, ShapeType>> = {
  [TOOL]: { kind: "object", fields: { total: { kind: "number" } } },
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
