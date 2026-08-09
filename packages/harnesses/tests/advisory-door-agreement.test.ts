/**
 * ADVISORY COMPILE ISSUES ARE ADVISORY AT EVERY DOOR.
 *
 * #906 put ONE floor behind the four doors an app reaches a screen through, but
 * the COMPILE issues in FRONT of that floor were still classified twice. The
 * paint seam refuses only what did not parse — `compile-failed`, `missing-app`
 * (`render-seam.ts`) — while `validateCompiledCreate` turned EVERY wire issue
 * into a block.
 *
 * `wire-id-ignored` is where the two disagreed, and it is not a code a model has
 * to invent: `checkoutApp` writes an app's own `app.vendo` with
 * `printWire(…, { includeIds: true })` (`@vendoai/apps` app-source.ts), so every
 * element of a checked-out app carries an id, and recompiling those bytes raises
 * exactly that issue and nothing else. The seam painted them; `validate({
 * document })` refused them — the door the assembly loop is told to call "the
 * floor" answering "does not pass" over our own printer's output. PR #913
 * measured the disagreement and deliberately left it; this closes it.
 *
 * So ONE document — the printer's own output — walks the doors, each through its
 * real entry point, and every door must reach the SAME verdict. Nothing is
 * stubbed: the seam is the real `commit()` proxy, the floor is the real floor off
 * `AppsRuntime.floor`, the row `validate({ appId })` judges is the one the real
 * paint created through `AppsRuntime.authored`, and `validate` is the shipped
 * verb. The fourth door — the edit path — is not reachable from this package; it
 * reads the same shared classification and is driven in
 * `packages/apps/src/one-floor.test.ts`.
 *
 * The one that must be able to fail: put `compiled.issues.map(…)` back in
 * `apps/generation/validation/validate.ts` and `validate({ document })` goes red
 * on `wire wire-id-ignored: …` while the seam beside it still paints.
 */
import { createApps } from "@vendoai/apps";
import {
  compileWire,
  printWire,
  type AppId,
  type NormalizedCatalog,
  type ToolRegistry,
  type VendoViewPart,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { describe, expect, it } from "vitest";
import { wrapWorkspaceForRender } from "../src/render-seam.js";
import { ctx, scriptedModel, testGuard, testWorkspace } from "../src/test-doubles.test-util.js";

const APP_ID = "app_advisory_door" as AppId;
const APP_VENDO = `/user/apps/${APP_ID}/app.vendo`;

const catalog: NormalizedCatalog = [];

const tools: ToolRegistry = {
  async descriptors() {
    return [];
  },
  async execute() {
    return { status: "error", error: { code: "not-found", message: "no tools" } };
  },
};

/** A sound app — nothing here is wrong with it at any door. */
const SOUND = '<App name="Spending"><Stack><Text text="This month" /></Stack></App>';

/** …and the bytes a CHECKOUT writes for that same app: the id-anchored print,
 *  which is the one wire this codebase produces that raises `wire-id-ignored`. */
const CHECKED_OUT = printWire(compileWire(SOUND, {}), { includeIds: true });

const context = ctx({ venue: "app" });

/** A real apps runtime. The model is scripted-empty on purpose: every door under
 *  test here is deterministic, and the AI reviewer `validate({ appId })` runs is
 *  fail-open, so a model that answers nothing costs no findings. */
const appsRuntime = () => createApps({
  store: memoryStoreAdapter(),
  guard: testGuard(),
  tools,
  catalog,
  model: scriptedModel([]),
});

describe("an advisory compile issue is advisory at every door", () => {
  it("the document under test carries wire-id-ignored and nothing else", () => {
    // Without this the rest could pass on a document that raises no issue at all.
    const codes = new Set(compileWire(CHECKED_OUT, {}).issues.map(({ code }) => code));
    expect([...codes]).toEqual(["wire-id-ignored"]);
  });

  it("the paint seam paints it, and both validate doors pass the very same bytes", async () => {
    const runtime = appsRuntime();
    const emitted: VendoViewPart[] = [];
    const workspace = wrapWorkspaceForRender(testWorkspace(), {
      emit: (_streamId, part) => emitted.push(part),
      floor: runtime.floor(context),
      authoredApp: (input) => runtime.authored(input, context),
    });

    // DOOR 1 — the paint seam, through the real write-then-commit path.
    await workspace.writeFile(APP_VENDO, CHECKED_OUT);
    await workspace.commit();
    expect(emitted.map((part) => part.appId)).toContain(APP_ID);

    // DOOR 2 — `validate({ document })` on the SAME bytes the seam just painted.
    const onDocument = await runtime.validate({ document: CHECKED_OUT }, context);
    // Named, not merely counted: the point is WHICH issue must not block.
    expect(onDocument.findings.map(({ message }) => message).join("\n")).not.toContain("wire-id-ignored");
    expect(onDocument.ok).toBe(true);

    // DOOR 3 — `validate({ appId })` on the row that paint created, which is the
    // door the assembly loop's brief actually names.
    const onRow = await runtime.validate({ appId: APP_ID }, context);
    expect(onRow.ok).toBe(true);
  }, 60_000);

  it("a wire issue that is NOT advisory still blocks — the floor did not get softer", async () => {
    // `unknown-reference`: the binding names no declared query, so the attribute
    // is DROPPED and the app promises a value it cannot show. Advisory is one
    // named class, never "compile issues stopped mattering".
    const broken = '<App name="Spending"><Stack><Text text={nope.total} /></Stack></App>';
    expect(compileWire(broken, {}).issues.map(({ code }) => code)).toContain("unknown-reference");

    const result = await appsRuntime().validate({ document: broken }, context);

    expect(result.ok).toBe(false);
    expect(result.findings.map(({ message }) => message).join("\n")).toContain("unknown-reference");
  }, 60_000);
});
