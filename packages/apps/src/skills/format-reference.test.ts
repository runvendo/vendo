/**
 * The reference is documentation a MODEL copies from, so its examples are tested
 * the way code is: every fenced `<Plan>` and `<App>` block in it goes through the
 * real compiler, and every element and function it claims exists must exist.
 *
 * A reference that teaches syntax the parser rejects is worse than no reference —
 * the model follows it, the app fails validation, and the model has no way to
 * learn which of the two was wrong.
 */
import { compilePlan, compileWire, EXPR_CALLS, RESHAPE_OPS, WIRE_COMPONENT_NAMES } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { VENDO_FORMAT_REFERENCE } from "./format-reference.js";

const FENCED = /```\n([\s\S]*?)```/g;

/** Every fenced block whose first non-space character opens the named element. */
const blocks = (tag: string): string[] =>
  [...VENDO_FORMAT_REFERENCE.matchAll(FENCED)]
    .map(([, body]) => (body ?? "").trim())
    .filter((body) => body.startsWith(`<${tag}`));

describe("every plan example in the reference compiles", () => {
  const examples = blocks("Plan");

  it("has plan examples to check at all", () => {
    expect(examples.length).toBeGreaterThanOrEqual(2);
  });

  for (const [index, example] of examples.entries()) {
    it(`plan example ${index + 1} compiles with no issues`, () => {
      // The facts a real deployment supplies. The example's tool and component
      // names are the ones it names — what is under test is the SYNTAX.
      const tools = [...example.matchAll(/tool="([^"]+)"/g)].map(([, name]) => name as string);
      const components = [...example.matchAll(/component="([^"]+)"/g)].map(([, name]) => name as string);

      const result = compilePlan(example, { tools, components });
      expect(result.issues).toEqual([]);
      expect(result.plan?.groups.length ?? 0).toBeGreaterThan(0);
    });
  }
});

describe("every app example in the reference compiles", () => {
  const examples = blocks("App");

  it("has app examples to check at all", () => {
    expect(examples.length).toBeGreaterThanOrEqual(2);
  });

  for (const [index, example] of examples.entries()) {
    it(`app example ${index + 1} compiles with no issues`, () => {
      const result = compileWire(example);
      expect(result.issues).toEqual([]);
      expect(result.complete).toBe(true);
      // Every component it names ships with the format — the examples must never
      // depend on a host catalog a reader does not have.
      const named = result.tree.nodes.map((node) => node.component);
      expect(named.filter((name) => !WIRE_COMPONENT_NAMES.includes(name))).toEqual([]);
    });
  }
});

describe("the reference only names things that exist", () => {
  it("documents exactly the expression functions the evaluator implements", () => {
    for (const call of EXPR_CALLS) {
      expect(VENDO_FORMAT_REFERENCE).toContain(`\`${call}(`);
    }
  });

  it("names no reshape op outside the closed registry, and skips the deprecated ones", () => {
    const documented = [...VENDO_FORMAT_REFERENCE.matchAll(/\|\s*\\?`([a-zA-Z]+)`(?:\s*\\?`[a-zA-Z]+`)*\s*\|/g)]
      .flatMap(([row]) => [...row.matchAll(/`([a-zA-Z]+)`/g)].map(([, op]) => op as string))
      .filter((op) => (RESHAPE_OPS as readonly string[]).includes(op));

    expect(documented).toContain("pick");
    expect(documented).toContain("format");
    // Deprecated by the dialect retirement — parsed for stored apps, never taught.
    expect(VENDO_FORMAT_REFERENCE).not.toContain("asOptions");
    expect(VENDO_FORMAT_REFERENCE).not.toContain("currencyCents");
    // v3 §5 (D1/D2): the aggregates retired from the reshape vocabulary with
    // the pipe. The reference teaches ONE of each, in the call grammar.
    expect(documented).not.toContain("avg");
    expect(VENDO_FORMAT_REFERENCE).not.toContain("| avg");
    expect(VENDO_FORMAT_REFERENCE).toContain('sum(rows, "field")');
  });

  it("teaches the plan's real element set and no invented one", () => {
    for (const element of ["<Plan", "<Query", "<Group", "<Leaf", "<Server", "<Island", "<Cannot"]) {
      expect(VENDO_FORMAT_REFERENCE).toContain(element);
    }
    // There is no <Tab> element in either dialect, and saying so is the point.
    expect(VENDO_FORMAT_REFERENCE).toContain("There is no `<Tab>`");
  });

  it("carries the component prop schemas, generated from the specs", () => {
    // The host catalog is on the host/components mount; everything that ships
    // with the format has to be IN here, or its props are unknowable.
    expect(VENDO_FORMAT_REFERENCE).toContain("# The Kit");
    expect(VENDO_FORMAT_REFERENCE).toContain("## <DataTable>");
    // Workspace-RELATIVE: the mount lands under the machine's root
    // (`/workspace/host/...` in a box), which is the session's cwd, so a leading
    // slash would point at a directory that does not exist on either leg.
    expect(VENDO_FORMAT_REFERENCE).toContain("`host/components/<Name>.md`");
    expect(VENDO_FORMAT_REFERENCE).not.toContain("/host/components/");
  });
});
