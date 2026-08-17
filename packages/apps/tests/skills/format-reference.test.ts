/**
 * The reference is documentation a MODEL copies from, so its worked screen is
 * tested the way code is: it goes through the REAL save-time gauntlet
 * (`checkComponentScreen` — esbuild, the import/query scan, the type check
 * against the generated declarations, and one actual render in the QuickJS VM),
 * with nothing stubbed but the host's own tools.
 *
 * A reference that teaches a screen the checks reject is worse than no reference
 * — the model follows it, the save fails, and the model has no way to learn
 * which of the two was wrong.
 *
 * The wire-dialect halves of this file went with the dialect: a screen is
 * `app.tsx` now (`contract/genui/component/types.ts` SCREEN_FILE), so there is
 * no `<Plan>`/`<App>` markup, no closed expression-call vocabulary and no
 * reshape pipe left in the reference to check.
 */
import type { HostToolInfo } from "../../src/server/checking/deps.js";
import {
  KIT_COMPONENT_NAMES,
  VENDO_THEME_VARIABLE_NAMES,
  defaultVendoTheme,
  themeCssVariables,
} from "../../src/contract/index.js";
import { checkComponentScreen } from "../../src/server/checking/component-screen.js";
import { SCREEN_MODULE, screenCatalog } from "../../src/server/checking/screen-typings.js";
import { describe, expect, it } from "vitest";
import { VENDO_FORMAT_REFERENCE } from "../../src/server/skills/format-reference.js";

/** Every fenced TSX block in the reference that is a WHOLE screen. The chapter
 *  opens with a deliberately elided skeleton (`export default function
 *  Overview() { … }`), which is a shape, not a file — the ellipsis is how it
 *  says so, and the gauntlet has nothing to compile in one. */
const screenExamples = (): string[] =>
  [...VENDO_FORMAT_REFERENCE.matchAll(/```tsx\n([\s\S]*?)```/g)]
    .map(([, body]) => (body ?? "").trim())
    .filter((body) => body.includes("export default function") && !body.includes("…"));

/** The two tools the worked screen names, with the declared schemas a real
 *  deployment supplies — the reference's example is under test, so its tool
 *  names and its fields are the ones IT names. */
const HOST_TOOLS: readonly HostToolInfo[] = [
  {
    name: "list_pending_transfers",
    description: "Transfers that have not gone out yet.",
    risk: "read",
    outputSchema: {
      type: "object",
      required: ["data"],
      properties: {
        data: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "recipient", "amount_cents", "scheduled_for"],
            properties: {
              id: { type: "string" },
              recipient: { type: "string" },
              amount_cents: { type: "number" },
              scheduled_for: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    name: "cancel_transfer",
    description: "Cancel a transfer before it goes out.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
  },
];

const ROWS = [
  { id: "tr_1", recipient: "Acme Utilities", amount_cents: 140_000, scheduled_for: "2026-08-14" },
  { id: "tr_2", recipient: "Blue Ridge Rent", amount_cents: 220_000, scheduled_for: "2026-08-15" },
];

describe("every screen the reference teaches passes the real save-time gauntlet", () => {
  const examples = screenExamples();

  it("has a whole screen to check at all", () => {
    expect(examples.length).toBeGreaterThanOrEqual(1);
  });

  for (const [index, source] of examples.entries()) {
    it(`screen example ${index + 1} lands with no findings, and paints`, async () => {
      const result = await checkComponentScreen({
        source,
        hostTools: HOST_TOOLS,
        // The Kit alone: an example must never depend on a host catalog a reader
        // does not have.
        catalog: screenCatalog([]),
        runQuery: async (tool) => (tool === "list_pending_transfers" ? { data: ROWS } : null),
      });

      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
      // It RENDERED — the check boots the screen on the answers its queries
      // really returned, so a reference example that type-checks and then throws
      // on real rows is caught here rather than on the person's screen.
      const tree = result.initialTree;
      expect(tree === undefined ? undefined : tree.nodes[tree.root]?.component).toBe("Stack");
      // Read once, through the tool the example names.
      expect(result.queryPlan).toEqual([{ tool: "list_pending_transfers" }]);
    });
  }
});

describe("the reference only teaches what a screen really has", () => {
  it("names the two modules a screen may import, and says they are the whole surface", () => {
    // The scan admits exactly `react` and SCREEN_MODULE
    // (checking/component-screen.ts ALLOWED_IMPORTS), so the module name comes
    // from the checker rather than from a reader.
    expect(VENDO_FORMAT_REFERENCE).toContain(`from "${SCREEN_MODULE}"`);
    expect(VENDO_FORMAT_REFERENCE).toContain('import { useState } from "react";');
    expect(VENDO_FORMAT_REFERENCE).toContain("Those two imports are everything there is.");
  });

  it("forbids the HTML and CSS a screen genuinely does not have", () => {
    // The display bricks are the ONLY HTML in the check's program, and they take
    // children and a style and nothing else — so `className` is still a type
    // error, and a color the model invents is still unbranded.
    expect(VENDO_FORMAT_REFERENCE).toMatch(/nothing else: no `className`, no `id`, no handlers/);
    expect(VENDO_FORMAT_REFERENCE).toMatch(/var\(--vendo-color-accent\)/);
    expect(VENDO_FORMAT_REFERENCE).toMatch(/no `fetch`, `localStorage` or `setTimeout`/);
    expect(VENDO_FORMAT_REFERENCE).toMatch(/there is no clock in here, so no\s+`new Date\(\)`/);
  });

  /** V4 retired the legacy prewired family — the Kit is the ONE component source,
   *  the tabular component is `DataTable`, and `Skeleton` became private chrome. A
   *  reference that still writes `Table` teaches a name nothing resolves: the type
   *  check has no such export and the screen never compiles. The examples are
   *  already covered (they go through the real gauntlet above); this is the PROSE,
   *  which nothing else reads. */
  it("teaches no retired component name", () => {
    for (const retired of ["Table", "Skeleton"]) {
      expect(KIT_COMPONENT_NAMES).not.toContain(retired);
      const named = VENDO_FORMAT_REFERENCE.replaceAll("DataTable", "")
        .match(new RegExp(`\\b${retired}\\b`, "g")) ?? [];
      expect(named, `the reference names the retired "${retired}" ${named.length}x`).toEqual([]);
    }
  });

  /** The checks are automatic on both legs — every save is checked on its way to
   *  the screen — and the screen agent's loadout carries no `validate` verb at
   *  all. So the chapter says the errors come back and never tells a reader to
   *  call anything: the reference is copied to a harness verbatim, so a call it
   *  teaches is a tool one reader cannot find. */
  it("says the save's own errors teach the repair, without naming a verb to call", () => {
    expect(VENDO_FORMAT_REFERENCE).toContain("Save errors tell you exactly what to fix. Fix and save again.");
    expect(VENDO_FORMAT_REFERENCE).not.toContain("`validate`");
  });

  /** The manual tells a model to style off the host's variables, so it has to say
   *  which ones exist: a guessed name resolves to nothing and the declaration
   *  falls back with no error anywhere. The section is walked off the EMITTER, so
   *  this compares the names it prints against what `themeCssVariables` really
   *  sets — the drift a hand-copied list would hide. */
  it("names every CSS variable the host really sets, in the order it sets them", () => {
    const named = [...VENDO_FORMAT_REFERENCE.matchAll(/^`(--vendo-[a-z0-9-]+)` — (.*)$/gm)];

    expect(named.map(([, name]) => name)).toEqual([...VENDO_THEME_VARIABLE_NAMES]);
    // Names alone would be a list to copy; the point is knowing which to reach for.
    expect(named.filter(([, , meaning]) => (meaning ?? "").trim() === "" || meaning === "undefined")).toEqual([]);
  });

  /** The list is one fixed set with ONE exception: `--vendo-heading-family` is
   *  emitted only when a host names a heading face (`themeCssVariables`'s
   *  `if (type.headingFamily)`). Documenting it flat, beside 51 names that are
   *  always there, teaches a variable that may not exist — so its line carries
   *  its own absence and the fallback to write instead, and the preamble's
   *  promise is what defers to it. */
  it("says so on the one line whose variable a host may not have set", () => {
    const conditional = Object.keys(themeCssVariables(defaultVendoTheme));

    expect(VENDO_THEME_VARIABLE_NAMES.filter((name) => !conditional.includes(name)))
      .toEqual(["--vendo-heading-family"]);
    expect(VENDO_FORMAT_REFERENCE)
      .toMatch(/^`--vendo-heading-family` — .*set only when this host names one/m);
    expect(VENDO_FORMAT_REFERENCE).toContain("unless its own line says otherwise");
  });

  it("lands the section in the reference, where the layout paragraph points", () => {
    expect(VENDO_FORMAT_REFERENCE).toContain("# The host's CSS variables");
    expect(VENDO_FORMAT_REFERENCE).toContain("listed at the end\nof this file");
  });

  it("carries the whole catalog, one line per component, generated from the specs", () => {
    // The host catalog is on the host/components mount; everything that ships
    // with the format has to be IN here, or its props are unknowable.
    expect(VENDO_FORMAT_REFERENCE).toContain("# The Kit");
    expect(VENDO_FORMAT_REFERENCE).toMatch(/^<DataTable> .* · data: rows!/m);
    // Workspace-RELATIVE: the mount lands under the machine's root
    // (`/workspace/host/...` in a box), which is the session's cwd, so a leading
    // slash would point at a directory that does not exist on either leg.
    expect(VENDO_FORMAT_REFERENCE).toContain("`host/components/<Name>.md`");
    expect(VENDO_FORMAT_REFERENCE).not.toContain("/host/components/");
  });
});
