import { describe, expect, it } from "vitest";
import { parseModelJson } from "./model-json.js";

describe("parseModelJson", () => {
  it("parses plain JSON, fenced JSON, and JSON wrapped in prose", () => {
    expect(parseModelJson('{"a":1}').value).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{"a":1}\n```').value).toEqual({ a: 1 });
    expect(parseModelJson('Sure! {"a":1} hope that helps').value).toEqual({ a: 1 });
  });

  it("reports invalid JSON as an issue instead of throwing", () => {
    expect(parseModelJson("not json").issues[0]).toMatch(/not valid JSON/);
    expect(parseModelJson('{"a":').issues[0]).toMatch(/not valid JSON/);
  });
});
