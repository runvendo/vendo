import { describe, expect, it } from "vitest";
import * as kit from "../../src/kit/index.js";

/**
 * The barrel IS the product here: an unexported module is a module a generated
 * app cannot import. The template and the builder prompt are both written
 * against this list, so it is asserted, not assumed.
 */
describe("@vendoai/ui/kit's export surface", () => {
  it("exports the runtime the blueprint promises", () => {
    for (const name of [
      // the reshape + aggregate vocabulary
      "reshape",
      "sum",
      "count",
      "average",
      "min",
      "max",
      "difference",
      "daysUntil",
      "groupBy",
      // the total forms, for a reason string
      "applyReshape",
      "evaluateExpr",
      // the provider and the hooks
      "VendoAppProvider",
      "useVendoApp",
      "appAddressFromPath",
      "useToolQuery",
      "useToolAction",
      "useVendoState",
    ]) {
      expect(typeof kit[name as keyof typeof kit], name).not.toBe("undefined");
    }
  });

  it("ships the Kit itself, so code-land renders the same components", () => {
    for (const name of ["Stat", "DataTable", "LineChart", "Button", "fmt", "KIT_COMPONENTS", "useKeyedState"]) {
      expect(typeof kit[name as keyof typeof kit], name).not.toBe("undefined");
    }
  });

  it("wraps the eight LIVE reshape ops and neither deprecated one (avg retired, #808)", () => {
    expect(Object.keys(kit.reshape).sort()).toEqual(
      ["asPoints", "count", "format", "max", "min", "pick", "rename", "sum"],
    );
  });
});
