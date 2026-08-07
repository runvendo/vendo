/**
 * The reference is documentation a MODEL copies from, so its examples are tested
 * the way code is: every fenced `<Plan>` and `<App>` block in it goes through the
 * real compiler, and every element and function it claims exists must exist.
 *
 * A reference that teaches syntax the parser rejects is worse than no reference —
 * the model follows it, the app fails validation, and the model has no way to
 * learn which of the two was wrong.
 */
import { readFile } from "node:fs/promises";
import { compilePlan, compileWire, EXPR_CALLS, RESHAPE_OPS, WIRE_COMPONENT_NAMES } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { VENDO_FORMAT_REFERENCE } from "./format-reference.js";

const FENCED = /```\n([\s\S]*?)```/g;

const REPO_ROOT = new URL("../../../../", import.meta.url);
const PLAN_COMPILER = "packages/core/src/genui/plan/compile.ts";

/** The reference's own `<Plan>` section, up to the next heading. */
const planSection = (): string => {
  const start = VENDO_FORMAT_REFERENCE.indexOf("### `<Plan");
  const end = VENDO_FORMAT_REFERENCE.indexOf("\n### ", start + 1);
  return VENDO_FORMAT_REFERENCE.slice(start, end);
};

/** Every attribute the plan compiler reads off the `<Plan>` ROOT, scanned from
 *  the compiler itself — `head` is the root tag there, and every other element
 *  reads its own `attrs.props`. */
const planRootAttributes = async (): Promise<string[]> => {
  const source = await readFile(new URL(PLAN_COMPILER, REPO_ROOT), "utf8");
  return [...new Set([
    ...source.matchAll(/stringAttr\(head\.props, "(\w+)"\)/g),
    ...source.matchAll(/head\.props\??\.(\w+)/g),
  ].map(([, name]) => name as string))];
};

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

  /** The reference's header promises it is taken from the parsers, and a model
   *  that believes it strips whatever it does not find here — `display="stage"`
   *  went undocumented while the compiler read it, so a full-width app arrived
   *  as an inline card. This is the half that stops it drifting again: the
   *  attribute list comes from the compiler, not from a reader. */
  it("documents every attribute the plan compiler reads off `<Plan>`", async () => {
    const attributes = await planRootAttributes();
    // The scan itself is load-bearing: if the compiler stopped calling its root
    // tag `head`, this would empty out and the loop below would hold nothing.
    expect(attributes, `${PLAN_COMPILER} no longer reads <Plan> through \`head.props\``)
      .toEqual(expect.arrayContaining(["name", "display"]));
    const section = planSection();
    for (const attribute of attributes) {
      expect(section, `compilePlan reads <Plan ${attribute}> and the reference never says so`)
        .toContain(`\`${attribute}\``);
    }
    // And it must not deny the ones it does not list.
    expect(section).not.toMatch(/No other attribute on `<Plan>` is read/);
  });

  it("teaches the plan's real element set and no invented one", () => {
    for (const element of ["<Plan", "<Query", "<Group", "<Leaf", "<Server", "<Island", "<Cannot"]) {
      expect(VENDO_FORMAT_REFERENCE).toContain(element);
    }
    // There is no <Tab> element in either dialect, and saying so is the point.
    expect(VENDO_FORMAT_REFERENCE).toContain("There is no `<Tab>`");
  });

  /** V4 retired the legacy prewired family — the Kit is the ONE component source,
   *  the tabular component is `DataTable`, and `Skeleton` became private chrome. A
   *  reference that still writes `Table` teaches a name nothing resolves: the
   *  compiler leaves it unknown and the node never paints. The examples are
   *  already covered (they compile against WIRE_COMPONENT_NAMES above); this is
   *  the PROSE, which nothing else reads. Arrived from the deleted
   *  `generation/contracts/sections.test.ts`, which asserted the same of a prompt
   *  section that no longer exists. */
  it("teaches no retired component name", () => {
    for (const retired of ["Table", "Skeleton"]) {
      expect(WIRE_COMPONENT_NAMES).not.toContain(retired);
      const named = VENDO_FORMAT_REFERENCE.replaceAll("DataTable", "")
        .match(new RegExp(`\\b${retired}\\b`, "g")) ?? [];
      expect(named, `the reference names the retired "${retired}" ${named.length}x`).toEqual([]);
    }
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
