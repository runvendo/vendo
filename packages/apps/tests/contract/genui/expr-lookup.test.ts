/**
 * `lookup` — the one cross-query ROW join in the `$expr` grammar.
 *
 * Two queries on one screen already combine in arithmetic (a path head names one
 * query, and one expression may name several). Rows did not: a row carrying
 * another query's id had no way to reach that query, so the screen either showed
 * the raw id or the writer hand-rolled an island. These tests pin the three
 * surfaces of the join together — it parses, it evaluates, and its findings name
 * the real fields before the app ships.
 */
import { describe, expect, it } from "vitest";
import { type Json, type ShapeType } from "@vendoai/core";
import {
  checkExpr,
  evaluateExpr,
  exprPathHeads,
  parseExpr,
  type ExprCheckContext,
} from "../../../src/contract/genui/expr.js";
import { compileWire } from "../../../src/contract/genui/wire/compile.js";
import { printWire } from "../../../src/contract/genui/wire/print.js";

const data: Record<string, Json> = {
  tasks: {
    data: [
      { id: "t_1", key: "ATL-1", assignee: "m_theo", points: 3 },
      { id: "t_2", key: "ATL-2", assignee: "m_ivy", points: 5 },
      // Nobody owns this one — the world writes an empty string for that.
      { id: "t_3", key: "ATL-3", assignee: "", points: 1 },
    ],
  },
  members: {
    data: [
      { id: "m_theo", name: "Theo Vance", capacityPoints: 13 },
      { id: "m_ivy", name: "Ivy Chen", capacityPoints: 13 },
    ],
  },
  nothing: { data: [] },
};

const rowsShape = (fields: Record<string, ShapeType>): ShapeType => ({
  kind: "object",
  fields: { data: { kind: "array", items: { kind: "object", fields } } },
});

const shapes: Record<string, ShapeType> = {
  tasks: rowsShape({
    id: { kind: "string" },
    key: { kind: "string" },
    assignee: { kind: "string" },
    points: { kind: "number" },
  }),
  members: rowsShape({
    id: { kind: "string" },
    name: { kind: "string" },
    capacityPoints: { kind: "number" },
  }),
};

const context: ExprCheckContext = {
  queryNames: ["tasks", "members"],
  shapeOf: (name) => shapes[name],
};

const valueOf = (source: string, over: Record<string, Json> = data): Json | undefined => {
  const result = evaluateExpr(source, over);
  if (!result.ok) throw new Error(`expected a value, got the issue: ${result.issue}`);
  return result.value;
};

const issueOf = (source: string, over: Record<string, Json> = data): string => {
  const result = evaluateExpr(source, over);
  if (result.ok) throw new Error(`expected an issue, got the value: ${JSON.stringify(result.value)}`);
  return result.issue;
};

const JOIN = 'lookup(tasks.data, "assignee", members.data, "id", "name")';

describe("lookup parses as one call over two named lists", () => {
  it("accepts the join", () => {
    expect(parseExpr(JOIN).ok).toBe(true);
  });

  it("reads both queries, so the compiler resolves both heads", () => {
    const parsed = parseExpr(JOIN);
    expect(parsed.ok && exprPathHeads(parsed.node)).toEqual(["tasks", "members"]);
  });

  it("refuses a list it cannot name", () => {
    const parsed = parseExpr('lookup(tasks.data, "assignee", "members", "id", "name")');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.issue).toContain("joins the two lists of rows you name");
  });

  it("refuses an unquoted field name", () => {
    const parsed = parseExpr("lookup(tasks.data, assignee, members.data, id, name)");
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.issue).toContain("names its three fields in quotes");
  });

  it("refuses the wrong number of arguments", () => {
    const parsed = parseExpr('lookup(tasks.data, "assignee", members.data)');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.issue).toContain("takes 5 arguments, not 3");
  });
});

describe("lookup shows the other query's label", () => {
  it("replaces the reference with the matching row's field and keeps everything else", () => {
    expect(valueOf(JOIN)).toEqual([
      { id: "t_1", key: "ATL-1", assignee: "Theo Vance", points: 3 },
      { id: "t_2", key: "ATL-2", assignee: "Ivy Chen", points: 5 },
      { id: "t_3", key: "ATL-3", assignee: null, points: 1 },
    ]);
  });

  it("keeps every row, so a reference matching nothing is empty rather than gone", () => {
    const joined = valueOf(JOIN) as Array<Record<string, Json>>;
    expect(joined).toHaveLength(3);
    expect(joined[2]?.assignee).toBeNull();
  });

  it("leaves the row's own id alone, so a row action still has it", () => {
    const joined = valueOf(JOIN) as Array<Record<string, Json>>;
    expect(joined.map((row) => row.id)).toEqual(["t_1", "t_2", "t_3"]);
  });

  it("joins to nothing when the other query is empty", () => {
    expect(valueOf('lookup(tasks.data, "assignee", nothing.data, "id", "name")', data))
      .toEqual([
        { id: "t_1", key: "ATL-1", assignee: null, points: 3 },
        { id: "t_2", key: "ATL-2", assignee: null, points: 5 },
        { id: "t_3", key: "ATL-3", assignee: null, points: 1 },
      ]);
  });

  it("reads a query that has not arrived as still loading, not as a mismatch", () => {
    expect(evaluateExpr(JOIN, { tasks: data.tasks as Json })).toEqual({ ok: true, value: undefined });
  });

  it("takes the first match when the other query repeats a key", () => {
    const repeated: Record<string, Json> = {
      tasks: { data: [{ assignee: "m_theo" }] },
      members: { data: [{ id: "m_theo", name: "First" }, { id: "m_theo", name: "Second" }] },
    };
    expect(valueOf(JOIN, repeated)).toEqual([{ assignee: "First" }]);
  });

  it("names the real fields when the reference field is absent", () => {
    expect(issueOf('lookup(tasks.data, "owner", members.data, "id", "name")'))
      .toContain('"owner" is absent from the rows of "tasks.data"');
  });

  it("names the real fields when the matched field is absent", () => {
    expect(issueOf('lookup(tasks.data, "assignee", members.data, "member_id", "name")'))
      .toContain('"member_id" is absent from the rows of "members.data"');
  });

  it("says so when a side is not a list of rows", () => {
    expect(issueOf('lookup(tasks.data, "assignee", members, "id", "name")'))
      .toContain("lookup() joins lists of rows");
  });
});

describe("lookup's findings arrive before the app ships", () => {
  it("passes the join the shapes really carry", () => {
    expect(checkExpr(JOIN, context)).toEqual([]);
  });

  it("catches a reference field the left rows do not carry", () => {
    expect(checkExpr('lookup(tasks.data, "owner", members.data, "id", "name")', context))
      .toEqual(['"owner" is absent from the rows of "tasks.data" — the fields they carry are: id, key, assignee, points']);
  });

  it("catches a shown field the other rows do not carry", () => {
    expect(checkExpr('lookup(tasks.data, "assignee", members.data, "id", "label")', context))
      .toEqual(['"label" is absent from the rows of "members.data" — the fields they carry are: id, name, capacityPoints']);
  });

  it("reports an undeclared query once per list, not once per field name", () => {
    const findings = checkExpr('lookup(issues.data, "assignee", members.data, "id", "name")', context);
    expect(findings).toEqual(['"issues.data" does not name a declared query; the queries are: tasks, members']);
  });

  it("reads as the list of rows it is when arithmetic asks it for a number", () => {
    expect(checkExpr(`${JOIN} * 2`, context))
      .toEqual([`${JOIN} is a list, not a single number — reduce it with sum(), count(), or average() first`]);
  });

  it("refuses to show a field that is not one value per row", () => {
    const nested: ExprCheckContext = {
      queryNames: ["tasks", "members"],
      shapeOf: (name) => (name === "members"
        ? rowsShape({ id: { kind: "string" }, name: { kind: "object", fields: { first: { kind: "string" } } } })
        : shapes[name]),
    };
    expect(checkExpr(JOIN, nested))
      .toEqual(['lookup() shows one value per row, and members.data.name is an object — name a scalar field to show']);
  });
});

describe("a screen can bind the join", () => {
  it("compiles to one computed binding that reads both queries", () => {
    const result = compileWire(`<App name="Cycle">
  <Query id="tasks" tool="list_tasks"/>
  <Query id="members" tool="list_members"/>
  <DataTable rows={${JOIN}} columns={[{key:"key"},{key:"assignee",label:"Owner"}]}/>
</App>`);
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
    const table = result.tree.nodes.find((node) => node.component === "DataTable");
    expect(table?.props?.rows).toEqual({ $expr: JOIN });
  });

  it("prints back verbatim, so the screen the type check reads is the one that shipped", () => {
    const wire = `<App name="Cycle">
  <Query id="tasks" tool="list_tasks"/>
  <Query id="members" tool="list_members"/>
  <DataTable rows={${JOIN}} columns={[{key:"assignee",label:"Owner"}]}/>
</App>`;
    const compiled = compileWire(wire);
    const printed = printWire({ tree: compiled.tree, components: {}, name: "Cycle" }, { includeIds: false });
    expect(printed).toContain(`rows={${JOIN}}`);
    expect(compileWire(printed).tree).toEqual(compiled.tree);
  });

  it("still refuses a join naming a query the screen never declared", () => {
    const result = compileWire(`<App name="Cycle">
  <Query id="tasks" tool="list_tasks"/>
  <DataTable rows={${JOIN}}/>
</App>`);
    expect(result.issues.map((issue) => issue.code)).toContain("unknown-reference");
  });
});
