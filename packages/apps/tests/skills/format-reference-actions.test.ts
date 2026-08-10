/**
 * The reference's ACTION claims, checked against the compiler that reads them.
 *
 * The manual used to say an `on*` attribute "names a host tool" and stop there.
 * A writer who believes that has no way to hand a tool the id it requires, and
 * the measured failure is exactly that: `cancel_transfer … missing required
 * argument "id"`, worked around by asking the person to copy an id off the
 * screen into a `<Form>` whose fields reach nothing. The argument-carrying form
 * was in the compiler, the printer, the renderer and the call door the whole
 * time, so these tests pin the manual to it — a reference that denies what the
 * parser accepts costs more than a missing page.
 */
import {
  ISLAND_AMBIENT_HELPER_NAMES,
  compileWire,
  printWire,
} from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { VENDO_FORMAT_REFERENCE } from "../../src/server/skills/format-reference.js";

const APP = `<App name="Transfers">
  <Query id="transfers" tool="list_transfers" input={{ limit: 50 }}/>
  <Button label="Cancel the first one" onClick={{ action: "cancel_transfer", payload: { id: transfers.data.0.id } }}/>
  <Button label="Refresh" onClick="list_transfers"/>
</App>`;

describe("an action carries its arguments", () => {
  const result = compileWire(APP);

  it("compiles clean, with the payload's reference lowered to a binding", () => {
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
    const cancel = result.tree.nodes.find((node) => node.props?.label === "Cancel the first one");
    expect(cancel?.props?.onClick).toEqual({
      action: "cancel_transfer",
      payload: { id: { $path: "/transfers/data/0/id" } },
    });
  });

  it("keeps the bare form bare — the two are one attribute with two shapes", () => {
    const refresh = result.tree.nodes.find((node) => node.props?.label === "Refresh");
    expect(refresh?.props?.onClick).toEqual({ action: "list_transfers" });
  });

  it("round-trips, so editing an app never loses the arguments", () => {
    const printed = printWire(result, { includeIds: false });
    expect(printed).toContain('action: "cancel_transfer"');
    expect(printed).toContain("payload:");
    const again = compileWire(printed);
    expect(again.issues).toEqual([]);
    expect(again.tree).toEqual(result.tree);
  });
});

describe("the reference describes that dialect", () => {
  it("teaches the payload form of an action", () => {
    expect(VENDO_FORMAT_REFERENCE).toContain("payload");
    expect(VENDO_FORMAT_REFERENCE).toContain("`payload` IS the tool's arguments");
    // And it must not go back to claiming the bare form is the whole story.
    expect(VENDO_FORMAT_REFERENCE).not.toContain("An `on*` attribute names a host tool:");
  });

  it("names every ambient helper an island really gets", () => {
    for (const helper of ISLAND_AMBIENT_HELPER_NAMES) {
      expect(VENDO_FORMAT_REFERENCE, `islands get \`${helper}\` and the reference never says so`)
        .toContain(`\`${helper}\``);
    }
  });
});
