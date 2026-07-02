import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateJson } from "./llm.js";
import { textModel } from "./test-helpers.js";

const schema = z.object({ ok: z.boolean() });

describe("generateJson", () => {
  it("parses fenced JSON", async () => {
    const model = textModel(['```json\n{"ok": true}\n```']);
    expect(await generateJson({ model, schema, prompt: "x" })).toEqual({ ok: true });
  });

  it("retries once with the validation error, then throws", async () => {
    const model = textModel(["not json", "still not json"]);
    await expect(generateJson({ model, schema, prompt: "x" })).rejects.toThrow(/after retry/);
  });

  it("recovers on the retry", async () => {
    const model = textModel(["nope", '{"ok": false}']);
    expect(await generateJson({ model, schema, prompt: "x" })).toEqual({ ok: false });
  });
});
