/**
 * An action that carries arguments — the seam, end to end.
 *
 * A tool with a required argument can only be reached from a screen through the
 * `{action, payload}` form of an `on*` attribute. Every layer already supported
 * it and two layers refused it: the Kit spec typed an action prop as a bare
 * string, and that spec IS the ambient `.d.ts` the blocking tsc gate compiles a
 * screen against, so the only form that can send an argument was a type error.
 *
 * So this test walks the real producers and the real consumers with nothing
 * stubbed between them: compile the payload form, print it back, type-check the
 * printed text against the generated typings, and run the fact check that now
 * refuses the argument-less form.
 */
import {
  compileWire,
  printWire,
  type NormalizedCatalog,
  type Tree,
} from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { actionArgumentIssues } from "../../src/server/checking/facts.js";
import type { HostToolInfo } from "../../src/server/checking/deps.js";
import { screenTypings } from "../../src/server/checking/screen-typings.js";
import { screenTscFindings } from "../../src/server/checking/screen-tsc.js";

const cancelTransfer: HostToolInfo = {
  name: "host_cancelTransfer",
  description: "Cancel a pending transfer",
  risk: "destructive",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
};

const listTransfers: HostToolInfo = {
  name: "host_listTransfers",
  description: "Pending transfers",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
  outputSchema: {
    type: "object",
    properties: {
      data: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, to: { type: "string" }, amount: { type: "integer" } },
          required: ["id", "to", "amount"],
          additionalProperties: false,
        },
      },
    },
    required: ["data"],
    additionalProperties: false,
  },
};

const tools = [cancelTransfer, listTransfers];

const QUERY = '<Query id="transfers" tool="host_listTransfers"/>';

const treeFor = (body: string): Tree =>
  compileWire(`<App name="Transfers">${QUERY}${body}</App>`).tree;

describe("actionArgumentIssues", () => {
  it("refuses a control wired to an argument-taking tool with no payload, and prints the form to write instead", () => {
    const issues = actionArgumentIssues(treeFor('<Button label="Cancel" onClick="host_cancelTransfer"/>'), tools);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('required argument "id"');
    expect(issues[0]?.message).toContain('onClick={{action:"host_cancelTransfer", payload:{id: …}}}');
  });

  it("refuses a Form submit for the same reason — a form never sends its fields' values", () => {
    const issues = actionArgumentIssues(
      treeFor('<Form onSubmit="host_cancelTransfer"><Select options={transfers.data} valueField="id"/></Form>'),
      tools,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.where).toContain('prop "onSubmit"');
  });

  it("says nothing when the payload carries the tool's own argument", () => {
    const wire = '<Button label="Cancel" onClick={{action:"host_cancelTransfer", payload:{id: transfers.data.0.id}}}/>';

    expect(actionArgumentIssues(treeFor(wire), tools)).toEqual([]);
  });

  it("says nothing about a tool that requires nothing, and nothing at all without a tool list", () => {
    const tree = treeFor('<Button label="Refresh" onClick="host_listTransfers"/>');

    expect(actionArgumentIssues(tree, tools)).toEqual([]);
    expect(actionArgumentIssues(treeFor('<Button label="Cancel" onClick="host_cancelTransfer"/>'), undefined)).toEqual([]);
  });
});

describe("the payload form survives compile → tree → print → tsc", () => {
  const wire = '<App name="Transfers">'
    + QUERY
    + '<Button label="Cancel" variant="danger" onClick={{action:"host_cancelTransfer", payload:{id: transfers.data.0.id}}}/>'
    + "</App>";

  it("compiles to a canonical action prop whose payload is a real binding", () => {
    const compiled = compileWire(wire);

    expect(compiled.issues).toEqual([]);
    expect(compiled.tree.nodes[1]?.props?.onClick).toStrictEqual({
      action: "host_cancelTransfer",
      payload: { id: { $path: "/transfers/data/0/id" } },
    });
  });

  it("prints back as the expression form, never collapsed to the string form", () => {
    const printed = printWire(compileWire(wire), { includeIds: false });

    expect(printed).toContain('onClick={{ action: "host_cancelTransfer"');
    expect(printed).not.toContain('onClick="host_cancelTransfer"');
  });

  it("type-checks: the gate that once rejected the object form now accepts it", () => {
    const compiled = compileWire(wire);
    const findings = screenTscFindings({
      screen: printWire(compiled, { includeIds: false }),
      typings: screenTypings({
        catalog: [] as NormalizedCatalog,
        queries: [{ name: "transfers", tool: "host_listTransfers" }],
        toolOutputSchemas: { host_listTransfers: listTransfers.outputSchema },
      }),
    });

    expect(findings).toEqual([]);
  });
});
