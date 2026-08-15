import { describe, expect, it } from "vitest";
import { resolveIslandToolName, scanIslandTools } from "../../src/contract/screen-tools-scan.js";

describe("scanIslandTools", () => {
  it("collects literal member-access chains", () => {
    const source = `
      export default function Lookup() {
        const [hits, setHits] = useState([]);
        const run = async (q) => setHits((await tools.clients.search({ q })).data);
        const single = async () => tools.list_invoices({ status: "overdue" });
        return <Input onChange={run}/>;
      }`;
    const scan = scanIslandTools(source);
    expect(scan.paths).toEqual([["clients", "search"], ["list_invoices"]]);
    expect(scan.violations).toEqual([]);
  });

  it("rejects computed member access", () => {
    const scan = scanIslandTools('const name = "x"; const out = tools[name](); export default () => null;');
    expect(scan.violations.some((violation) => violation.includes("computed"))).toBe(true);
  });

  it("rejects computed access after a literal chain", () => {
    const scan = scanIslandTools('const out = tools.clients["search"]({}); export default () => null;');
    expect(scan.violations.some((violation) => violation.includes("computed"))).toBe(true);
  });

  it("rejects aliasing the tools object", () => {
    for (const source of [
      "const t = tools;",
      "run(tools);",
      "const fns = [tools];",
      "callWith({ api: tools });",
    ]) {
      const scan = scanIslandTools(source);
      expect(scan.violations.length, source).toBeGreaterThan(0);
    }
  });

  it("ignores the word tools in strings, comments, and JSX text", () => {
    const source = `
      // tools are ambient in comments too
      /* tools[expr] in a block comment */
      const label = "power tools";
      const tpl = \`no tools here\`;
      export default () => <p>my favorite tools are here</p>;`;
    const scan = scanIslandTools(source);
    expect(scan.paths).toEqual([]);
    expect(scan.violations).toEqual([]);
  });

  it("still scans code inside template interpolations", () => {
    const scan = scanIslandTools("const s = `total: ${await tools.metrics.total({})}`;");
    expect(scan.paths).toEqual([["metrics", "total"]]);
  });

  it("does not match identifiers that merely end in tools", () => {
    const scan = scanIslandTools("const powertools = 1; const x = powertools.spin();");
    expect(scan.paths).toEqual([]);
    expect(scan.violations).toEqual([]);
  });

  it("ignores un-called member chains in JSX prose (review: tools.Buy)", () => {
    const scan = scanIslandTools("export default () => <p>great tools.Buy now</p>;");
    expect(scan.paths).toEqual([]);
    expect(scan.violations).toEqual([]);
  });

  it("rejects optional-chained computed access (review: tools?.[expr])", () => {
    for (const source of ['tools?.["danger"]();', 'const out = tools.clients?.["search"]({});']) {
      const scan = scanIslandTools(source);
      expect(scan.violations.some((violation) => violation.includes("computed")), source).toBe(true);
    }
  });

  it("flags an un-called chain being passed around as aliasing", () => {
    const scan = scanIslandTools("const c = tools.clients;");
    expect(scan.violations.length).toBeGreaterThan(0);
  });
});

describe("resolveIslandToolName", () => {
  const known = new Set(["clients_search", "list_invoices", "host_metric"]);

  it("resolves dotted chains by underscore-join and flat names directly", () => {
    expect(resolveIslandToolName(["clients", "search"], known)).toBe("clients_search");
    expect(resolveIslandToolName(["list_invoices"], known)).toBe("list_invoices");
    expect(resolveIslandToolName(["host", "metric"], known)).toBe("host_metric");
  });

  it("returns null for unknown tools", () => {
    expect(resolveIslandToolName(["made", "up"], known)).toBeNull();
  });
});
