import { describe, expect, it } from "vitest";
import { IncrementalTreeParser, parseModelJson } from "./incremental-tree.js";

describe("IncrementalTreeParser", () => {
  it("flushes at complete node and query boundaries while tolerating a JSON fence", () => {
    const parser = new IncrementalTreeParser();
    expect(parser.push('```json\n{"name":"Demo","tree":{"formatVersion":"vendo-genui/v1","root":"r","nodes":['))
      .toBeUndefined();

    const root = parser.push('{"id":"r","component":"Stack","children":["child"]},');
    expect(root).toMatchObject({ name: "Demo", tree: { root: "r", nodes: [{ id: "r" }], streaming: true } });

    const child = parser.push('{"id":"child","component":"Text","props":{"text":"brace } and quote \\" stay text"}}');
    expect(child?.tree.nodes).toHaveLength(2);
    expect(child?.tree.nodes[1]?.props?.text).toBe('brace } and quote " stay text');

    const query = parser.push('],"queries":[{"path":"/metric","tool":"host_metric"}');
    expect(query?.tree.queries).toEqual([{ path: "/metric", tool: "host_metric" }]);
    parser.push(']}}\n```');

    expect(parseModelJson(parser.text())).toMatchObject({
      value: { name: "Demo", tree: { root: "r", nodes: expect.any(Array) } },
      issues: [],
    });
  });

  it("streams a generated node before its complete top-level component source", () => {
    const parser = new IncrementalTreeParser();
    const partial = parser.push(JSON.stringify({
      name: "Generated",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "r",
        nodes: [{ id: "r", component: "RevenueCard", source: "generated" }],
      },
    }).slice(0, -1) + ',"components":{');
    expect(partial?.tree.nodes).toHaveLength(1);
    expect(partial?.components).toBeUndefined();

    const withSource = parser.push('"RevenueCard":"export default function RevenueCard(){ return null }"');
    expect(withSource?.components?.RevenueCard).toContain("function RevenueCard");
    expect(withSource?.tree.components?.RevenueCard).toContain("function RevenueCard");
  });

  it("contains malformed output without inventing a partial tree", () => {
    const parser = new IncrementalTreeParser();
    expect(parser.push('{"name":"Broken","tree": nope')).toBeUndefined();
    expect(parseModelJson(parser.text()).issues[0]).toMatch(/not valid JSON/);
  });

  it("keeps complete nodes paintable even when the final JSON is truncated", () => {
    const parser = new IncrementalTreeParser();
    const partial = parser.push(
      '{"name":"Truncated","tree":{"formatVersion":"vendo-genui/v1","root":"r","nodes":[{"id":"r","component":"Text"},',
    );
    expect(partial?.tree.nodes).toEqual([{ id: "r", component: "Text" }]);
    expect(parseModelJson(parser.text()).issues[0]).toMatch(/not valid JSON/);
  });
});
