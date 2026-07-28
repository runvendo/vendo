import { describe, expect, it } from "vitest";
import { parseDraft } from "./harness.js";

/** Moved here verbatim from extraction.test.ts when the judgment layer deleted
 *  that module — `parseDraft` lives in harness.ts and is untouched, so its
 *  coverage must not disappear with its old test file's other subjects. */
describe("parseDraft", () => {
  it("parses a fenced json block and bare json", () => {
    const draft = { brief: "A bank.", tools: [{ name: "t", description: "d" }] };
    expect(parseDraft("Here you go:\n```json\n" + JSON.stringify(draft) + "\n```")).toEqual(draft);
    expect(parseDraft(JSON.stringify(draft))).toEqual(draft);
  });

  it("throws on unparseable or schema-invalid output", () => {
    expect(() => parseDraft("no json here")).toThrow();
    expect(() => parseDraft('{"brief":""}')).toThrow();
  });

  it("survives stray braces in surrounding prose (Greptile P2)", () => {
    const draft = { brief: "A bank.", tools: [{ name: "t", description: 'has "quotes" and {braces}' }] };
    const noisy = `Checked {src/api} — handler is write-only.\n${JSON.stringify(draft)}\nNote: {unbalanced`;
    expect(parseDraft(noisy)).toEqual(draft);
  });
});
