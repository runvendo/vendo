// The default reading of an unformatted value. A host's date field ships as
// `2026-08-01`; a column that forgot `format: "date"` used to print that wire
// spelling straight onto the screen, which no themed screen ever wants.
import { describe, expect, it } from "vitest";
import { applyFormat } from "../../src/kit/format.js";

describe("applyFormat with no token", () => {
  it("reads a bare ISO day as a date", () => {
    expect(applyFormat("2026-08-01")).toBe("Aug 1, 2026");
    expect(applyFormat(" 2026-08-01 ")).toBe("Aug 1, 2026");
  });

  it("leaves every other string alone", () => {
    expect(applyFormat("First Bank")).toBe("First Bank");
    expect(applyFormat("2026-08")).toBe("2026-08");
    expect(applyFormat("tr_2026-08-01")).toBe("tr_2026-08-01");
    expect(applyFormat("")).toBeNull();
  });

  it("still hands back the verbatim string for an explicit text token", () => {
    expect(applyFormat("2026-08-01", "text")).toBe("2026-08-01");
  });
});
