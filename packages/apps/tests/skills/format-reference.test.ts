/**
 * The reference is documentation a MODEL copies from, so its worked screens are
 * tested the way code is: each goes through the REAL save-time gauntlet
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

/** A read tool over rows, said once — the four worked screens each read one, and
 *  four hand-written envelopes would have been the same object copied four times. */
const reader = (name: string, description: string, fields: Record<string, string>): HostToolInfo => ({
  name,
  description,
  risk: "read",
  outputSchema: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "array",
        items: {
          type: "object",
          required: Object.keys(fields),
          properties: Object.fromEntries(Object.entries(fields).map(([field, type]) => [field, { type }])),
        },
      },
    },
  },
});

/** A write tool taking one id — every action the worked screens take. */
const idWriter = (name: string, description: string): HostToolInfo => ({
  name,
  description,
  risk: "write",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
    additionalProperties: false,
  },
});

/** The tools the worked screens name, with the declared schemas a real
 *  deployment supplies — the reference's examples are under test, so the tool
 *  names and the fields are the ones THEY name. */
const HOST_TOOLS: readonly HostToolInfo[] = [
  reader("list_pending_transfers", "Transfers that have not gone out yet.", {
    id: "string", recipient: "string", amount_cents: "number", scheduled_for: "string",
  }),
  idWriter("cancel_transfer", "Cancel a transfer before it goes out."),
  reader("list_open_bills", "Bills that are still open this month.", {
    id: "string", payee: "string", due_on: "string", amount_cents: "number",
  }),
  idWriter("pay_bill", "Pay one bill."),
  reader("list_plans", "The plans a person can be on.", {
    id: "string", name: "string", price_cents: "number", seats: "number", support: "string",
  }),
  idWriter("switch_plan", "Move to a different plan."),
  reader("list_tickets", "The open support tickets.", {
    id: "string", subject: "string", category: "string", status: "string", assignee: "string",
  }),
  idWriter("close_ticket", "Close one ticket."),
];

/**
 * What each read tool answers, for every example that asks it.
 *
 * Real rows, not empty ones: the run boots the screen on these and PRESSES every
 * control it drew, so a shape the examples teach — a total reduced off the rows, a
 * detail pane opened on the first one, a row action greyed out where it does not
 * apply — is only exercised on data that has rows to have them.
 */
const ANSWERS: Record<string, unknown> = {
  list_pending_transfers: {
    data: [
      { id: "tr_1", recipient: "Acme Utilities", amount_cents: 140_000, scheduled_for: "2026-08-14" },
      { id: "tr_2", recipient: "Blue Ridge Rent", amount_cents: 220_000, scheduled_for: "2026-08-15" },
    ],
  },
  list_open_bills: {
    data: [
      { id: "bi_1", payee: "Acme Utilities", due_on: "2026-08-20", amount_cents: 14_050 },
      { id: "bi_2", payee: "Blue Ridge Rent", due_on: "2026-08-28", amount_cents: 220_000 },
    ],
  },
  list_plans: {
    data: [
      { id: "pl_1", name: "Starter", price_cents: 0, seats: 1, support: "Community" },
      { id: "pl_2", name: "Team", price_cents: 4_900, seats: 10, support: "Email" },
      { id: "pl_3", name: "Scale", price_cents: 24_900, seats: 50, support: "Same day" },
    ],
  },
  list_tickets: {
    data: [
      { id: "tk_1", subject: "Card declined at checkout", category: "Billing", status: "open", assignee: "Dana" },
      { id: "tk_2", subject: "Cannot export statements", category: "Reports", status: "waiting", assignee: "Ravi" },
      // The row whose action does not apply — the disabled half of the shape.
      { id: "tk_3", subject: "Duplicate charge refunded", category: "Billing", status: "closed", assignee: "Dana" },
    ],
  },
};

describe("every screen the reference teaches passes the real save-time gauntlet", () => {
  const examples = screenExamples();

  it("has every worked screen to check", () => {
    // Four: the stacked list, the rows-to-total, the fixed-count comparison and
    // the master-detail split. A fifth is welcome; three means one was lost.
    expect(examples.length).toBeGreaterThanOrEqual(4);
  });

  for (const [index, source] of examples.entries()) {
    it(`screen example ${index + 1} lands with no findings, and paints`, async () => {
      const result = await checkComponentScreen({
        source,
        hostTools: HOST_TOOLS,
        // The Kit alone: an example must never depend on a host catalog a reader
        // does not have.
        catalog: screenCatalog([]),
        runQuery: async (tool) => ANSWERS[tool] ?? null,
      });

      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
      // It RENDERED — the check boots the screen on the answers its queries
      // really returned, so a reference example that type-checks and then throws
      // on real rows is caught here rather than on the person's screen.
      const tree = result.initialTree;
      expect(tree === undefined ? undefined : tree.nodes[tree.root]?.component).toBeDefined();
      // And every read it made named a tool this host answers: a query for a name
      // nothing declares boots the screen on `null`, which teaches a screen that
      // renders here and nowhere a person is.
      const read = result.queryPlan ?? [];
      expect(read.length).toBeGreaterThan(0);
      expect(read.filter(({ tool }) => ANSWERS[tool] === undefined)).toEqual([]);
    });
  }
});

/**
 * The four screens are four SHAPES, each one a technique the bench showed a
 * screen losing points for missing. Prose never taught them — a model copies the
 * example — so each one is pinned here: a technique that quietly leaves the
 * examples is a technique this manual no longer teaches, and the gauntlet above
 * would stay green all the way through losing it.
 */
describe("the worked screens teach the shapes a screen is graded on", () => {
  it("computes a total the ask named off the rows, and repeats it where it is acted on", () => {
    expect(VENDO_FORMAT_REFERENCE).toContain(".reduce((sum, bill) => sum + bill.amount_cents, 0)");
    // Twice: in the header, and again in the dialog that fires the batch — and
    // through the screen's own `money` helper both times, because a reduced total
    // is still cents and there is no component left that would divide it.
    expect([...VENDO_FORMAT_REFERENCE.matchAll(/money\(totalCents\)/g)]).toHaveLength(2);
  });

  it("takes a fixed column count for an ask that names what to compare", () => {
    expect(VENDO_FORMAT_REFERENCE).toContain("<Grid columns={3}");
  });

  it("opens the detail pane on the first row, never on nothing", () => {
    // Optional-chained on purpose: every world has an empty-state case, and a
    // screen copied verbatim from here must not throw on zero rows. The lesson is
    // that the selection comes from the DATA — `useState(null)` is what leaves the
    // pane blank on the paint a person is first shown.
    expect(VENDO_FORMAT_REFERENCE).toContain("useState(rows[0]?.id)");
    expect(VENDO_FORMAT_REFERENCE).not.toContain("useState(null)");
  });

  it("keeps the row action on every row, greyed out with its reason where it does not apply", () => {
    expect(VENDO_FORMAT_REFERENCE).toContain('disabled={row.status === "closed"}');
    expect(VENDO_FORMAT_REFERENCE).toContain('label={row.status === "closed" ? "Already closed"');
  });

  it("reads a filter's choices off the data instead of typing them out", () => {
    expect(VENDO_FORMAT_REFERENCE).toContain("options={[...new Set(rows.map((row) => row.category))]}");
  });

  it("updates state a sibling press can affect with the updater form, never the render's copy", () => {
    expect(VENDO_FORMAT_REFERENCE).toContain(
      "setOpenId((prev) => (prev === row.id ? rows.find((other) => other.id !== row.id)?.id : prev))",
    );
  });
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

  /** The clause that taught a crash. "Hands back the tool's result EXACTLY as
   *  the tool returns it" is false of the first paint: a read whose input the
   *  screen computes has no answer until the host supplies one, and the VM hands
   *  back `{ data: undefined }` until then (`genui/component/vm-program.ts`
   *  `MISS`). A model that believed the old sentence wrote `stages.data.length`
   *  and threw before the host got to answer — `buildlog/failure-log` on the
   *  bench. The manual owes the truth AND the shape it implies. */
  it("says a read may have no answer on the first paint, and what to draw then", () => {
    expect(VENDO_FORMAT_REFERENCE).not.toMatch(/EXACTLY as the tool returns/u);
    expect(VENDO_FORMAT_REFERENCE).toMatch(/has no answer on the first paint/u);
    expect(VENDO_FORMAT_REFERENCE).toMatch(/its `data` is\s+undefined until the host supplies it/u);
    expect(VENDO_FORMAT_REFERENCE).toMatch(/an unanswered read draws its empty shell/u);
  });

  /** "Never build a confirm step of your own" was written against the GUARD, which
   *  asks on the host's behalf — but the host also states rules of its own, and a
   *  brief whose `HOST DESIGN RULES` say an irreversible action asks for
   *  confirmation is naming a step of the product. A model that read the doctrine
   *  as absolute skipped it and failed the host's own rule (fleet run
   *  2026-08-18T21-39-10). The rules the brief carries outrank the default. */
  it("lets the host's own rules ask for a confirmation the guard would otherwise own", () => {
    expect(VENDO_FORMAT_REFERENCE).toMatch(/a confirmation THIS product's own rules require/u);
    expect(VENDO_FORMAT_REFERENCE).toMatch(/host design rules in the brief name an action as confirm-first/u);
    expect(VENDO_FORMAT_REFERENCE).toMatch(/The guard's own ask counts where it fires/u);
  });

  it("forbids the HTML and CSS a screen genuinely does not have", () => {
    // The display bricks are the ONLY HTML in the check's program, and they take
    // children and a style and nothing else — so `className` is still a type
    // error, and a color the model invents is still unbranded.
    expect(VENDO_FORMAT_REFERENCE).toMatch(/take children and an inline `style`, nothing else — no handlers/);
    expect(VENDO_FORMAT_REFERENCE).toMatch(/var\(--vendo-color-accent\)/);
    expect(VENDO_FORMAT_REFERENCE).toMatch(/no `fetch`, no `localStorage`,\s+no `setTimeout`/);
    expect(VENDO_FORMAT_REFERENCE).toMatch(/no timers, no clock:[\s\S]*no `new Date\(\)`/);
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
   *  all. The skill body is where the errors-come-back teaching lives now; what
   *  this file owes is naming no verb to call, because the reference is copied to
   *  a harness verbatim and a call it teaches is a tool one reader cannot find. */
  it("names no verb to call", () => {
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

  it("lands the section in the reference, where the layout bullet points", () => {
    expect(VENDO_FORMAT_REFERENCE).toContain("# The host's CSS variables");
    expect(VENDO_FORMAT_REFERENCE).toMatch(/is listed at the end of this\s+file/);
  });

  it("carries the whole catalog, one entry per component, generated from the specs", () => {
    // Everything that ships with the format has to be IN here, or its props are
    // unknowable. The host's own components are pointed at from the skill body,
    // which is the one place that names their directory.
    expect(VENDO_FORMAT_REFERENCE).toContain("# The Kit");
    expect(VENDO_FORMAT_REFERENCE).toMatch(/^### <DataTable>$/m);
    expect(VENDO_FORMAT_REFERENCE).toMatch(/^- data: `rows!/m);
    expect(VENDO_FORMAT_REFERENCE).not.toContain("host/components");
  });

  /** `/user|orgs/…/apps/app_<id>/app.tsx` — an id that does not start with
   *  `app_` paints nothing (render-seam.ts), and this chapter is the ONE place
   *  the directory shape is stated now. */
  it("names the app directory shape the render seam actually watches", () => {
    expect(VENDO_FORMAT_REFERENCE).toContain("user/apps/app_");
  });

  /** No icon vocabulary: 227 names cost ~575 tokens on every generation, and the
   *  checker refuses an invented one loudly — `<Icon>`'s own summary carries the
   *  kebab-case rule and three real names, which is what a model needs. */
  it("never spends the catalog on the icon vocabulary", () => {
    expect(VENDO_FORMAT_REFERENCE).not.toContain("Icon names —");
  });
});
