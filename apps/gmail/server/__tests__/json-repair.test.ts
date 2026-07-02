import { describe, expect, it } from "vitest";
import {
  escapeControlCharsInJsonStrings,
  repairToolInputText,
  jsonRepairMiddleware,
} from "../flowlet/json-repair";

describe("escapeControlCharsInJsonStrings", () => {
  it("escapes raw newlines/tabs inside string literals only", () => {
    const broken = '{"src": "line1\nline2\tend", "n": 3}';
    const fixed = escapeControlCharsInJsonStrings(broken);
    expect(JSON.parse(fixed)).toEqual({ src: "line1\nline2\tend", n: 3 });
  });

  it("leaves formatting whitespace between tokens alone", () => {
    const pretty = '{\n  "a": 1,\n  "b": "x"\n}';
    expect(escapeControlCharsInJsonStrings(pretty)).toBe(pretty);
  });

  it("respects escape sequences (a \\\" does not close the string)", () => {
    const broken = '{"s": "he said \\"hi\\"\nnext"}';
    expect(JSON.parse(escapeControlCharsInJsonStrings(broken))).toEqual({
      s: 'he said "hi"\nnext',
    });
  });

  it("handles the real failure shape: component source with raw newlines", () => {
    const broken =
      '{"components": {"TinderInbox": "\nimport { useState } from \'react\';\n\nexport default function T(){\n  return null;\n}"}}';
    const parsed = JSON.parse(escapeControlCharsInJsonStrings(broken)) as {
      components: { TinderInbox: string };
    };
    expect(parsed.components.TinderInbox).toContain("import { useState }");
    expect(parsed.components.TinderInbox.split("\n").length).toBeGreaterThan(3);
  });
});

describe("repairToolInputText", () => {
  it("returns valid input untouched", () => {
    expect(repairToolInputText('{"a":1}')).toBe('{"a":1}');
  });
  it("repairs control-char breakage", () => {
    expect(JSON.parse(repairToolInputText('{"a":"x\ny"}')!)).toEqual({ a: "x\ny" });
  });
  it("returns null when unrepairable", () => {
    expect(repairToolInputText('{"a": trailing garbage')).toBeNull();
  });
});

describe("jsonRepairMiddleware.transformParams", () => {
  it("re-parses string tool inputs and empties unrepairable ones", async () => {
    const params = {
      prompt: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "1", toolName: "render_view", input: '{"a":"x\ny"}' },
            { type: "tool-call", toolCallId: "2", toolName: "render_view", input: "not json {" },
            { type: "tool-call", toolCallId: "3", toolName: "ok_tool", input: { fine: true } },
          ],
        },
      ],
    };
    const out = (await jsonRepairMiddleware.transformParams!({
      type: "stream",
      params: params as never,
      model: {} as never,
    })) as typeof params;
    const content = out.prompt[1]!.content as { input: unknown }[];
    expect(content[0]!.input).toEqual({ a: "x\ny" });
    expect(content[1]!.input).toEqual({});
    expect(content[2]!.input).toEqual({ fine: true });
  });
});
