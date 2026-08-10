import { describe, expect, it } from "vitest";
import { compileWire, type WireCompileResult } from "../../../../src/contract/genui/wire/compile.js";
import { printWire } from "../../../../src/contract/genui/wire/print.js";
import { validateTree } from "../../../../src/contract/genui/tree.js";

/** The tool behind all seven observed dead-button runs. */
const cancelTools = {
  cancel_transfer: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
};

const compile = (wire: string, toolInputs: Record<string, unknown> = cancelTools): WireCompileResult =>
  compileWire(wire, { toolInputs, inlineRefs: true, inlineTools: ["list_transfers", "cancel_transfer"] });

const propsOf = (result: WireCompileResult, component: string): Record<string, unknown> | undefined =>
  result.tree.nodes.find((node) => node.component === component)?.props;

describe("autowireFormSubmits", () => {
  it("names the Select whose valueField IS the submit tool's missing argument", () => {
    const result = compile(`<App name="Cancel">
  <Query id="transfers" tool="list_transfers"/>
  <Form onSubmit="cancel_transfer" submitLabel="Cancel transfer">
    <Select label="Transfer" options={transfers.data} labelField="to" valueField="id"/>
  </Form>
</App>`);
    expect(propsOf(result, "Select")?.name).toBe("id");
    // The action itself is untouched: the values ride in at submit.
    expect(propsOf(result, "Form")?.onSubmit).toEqual({ action: "cancel_transfer" });
    expect(validateTree(result.tree)).toEqual({ ok: true, tree: result.tree });
  });

  it("names the single field in a form missing a single argument, however nested", () => {
    const result = compile(`<App name="Cancel">
  <Form onSubmit="cancel_transfer"><Row><Input label="Id"/></Row></Form>
</App>`);
    expect(propsOf(result, "Input")?.name).toBe("id");
  });

  it("leaves an argument the writer already declared alone", () => {
    const result = compile(`<App name="Cancel">
  <Query id="transfers" tool="list_transfers"/>
  <Form onSubmit={{ action: "cancel_transfer", payload: { id: "tr_1" } }}>
    <Select options={transfers.data} valueField="id"/>
  </Form>
</App>`);
    expect(propsOf(result, "Select")?.name).toBeUndefined();
  });

  it("guesses nothing when two fields could each supply the one argument", () => {
    const result = compile(`<App name="Cancel">
  <Form onSubmit="cancel_transfer"><Input label="A"/><Input label="B"/></Form>
</App>`);
    expect(propsOf(result, "Input")?.name).toBeUndefined();
  });

  it("does nothing without tool input schemas", () => {
    const bare = compileWire(`<App name="Cancel">
  <Form onSubmit="cancel_transfer"><Input label="Id"/></Form>
</App>`, { inlineRefs: true });
    expect(propsOf(bare, "Input")?.name).toBeUndefined();
  });

  it("round-trips through the printer and is idempotent on recompile", () => {
    const once = compile(`<App name="Cancel">
  <Form onSubmit="cancel_transfer"><Input label="Id"/></Form>
</App>`);
    const twice = compile(printWire(once, { includeIds: false }));
    expect(twice.tree).toEqual(once.tree);
    expect(twice.issues).toEqual([]);
  });
});
