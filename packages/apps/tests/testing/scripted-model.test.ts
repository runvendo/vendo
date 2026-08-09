/**
 * The scripted model fixture — SHIPPED code (`@vendoai/apps/testing`), and the
 * thing roughly forty suites in this repo and any host's own tests measure
 * against.
 *
 * That is exactly why it needs its own tests: a fixture nobody tests is a
 * measuring stick nobody has checked, and a silent change to it moves every
 * result that depends on it at once. So these drive it through the REAL AI SDK
 * (`generateText`, `streamText`) rather than by calling `doGenerate`/`doStream`
 * by hand — the fixture's whole contract is "the SDK can drive this", and only
 * the SDK can say whether that is true.
 */
import { generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { basicLanguageModel, scriptedLanguageModel, type ScriptedModelCall } from "../../src/testing/scripted-model.js";

const ask = (model: ReturnType<typeof scriptedLanguageModel>, prompt = "hello") =>
  generateText({ model, prompt });

describe("scriptedLanguageModel answers in script order", () => {
  it("returns each response in turn", async () => {
    const model = scriptedLanguageModel("first", "second");

    expect((await ask(model)).text).toBe("first");
    expect((await ask(model)).text).toBe("second");
  });

  it("repeats the LAST response once the script runs out", async () => {
    // Suites script the turns they care about and let the tail repeat; a throw
    // here would turn "one extra call" into an unrelated-looking failure.
    const model = scriptedLanguageModel("only");

    expect((await ask(model)).text).toBe("only");
    expect((await ask(model)).text).toBe("only");
    expect((await ask(model)).text).toBe("only");
  });

  it("joins an array response into one text answer", async () => {
    expect((await ask(scriptedLanguageModel(["chunk-", "ed"]))).text).toBe("chunk-ed");
  });
});

describe("a function response sees the real prompt and its turn index", () => {
  it("is handed the normalized prompt the SDK built", async () => {
    let seen: ScriptedModelCall | undefined;
    const model = scriptedLanguageModel((call) => { seen = call; return "ok"; });

    await generateText({ model, prompt: "count the invoices" });

    expect(JSON.stringify(seen?.prompt)).toContain("count the invoices");
  });

  it("is handed a zero-based turn index that advances", async () => {
    const indexes: number[] = [];
    const model = scriptedLanguageModel((_call, index) => { indexes.push(index); return "ok"; });

    await ask(model);
    await ask(model);

    expect(indexes).toEqual([0, 1]);
  });

  it("awaits an async response", async () => {
    const model = scriptedLanguageModel(async () => "eventually");

    expect((await ask(model)).text).toBe("eventually");
  });
});

describe("streaming", () => {
  it("streams an array response as separate deltas", async () => {
    const deltas: string[] = [];
    const result = streamText({ model: scriptedLanguageModel(["a", "b", "c"]), prompt: "hi" });

    for await (const delta of result.textStream) deltas.push(delta);

    expect(deltas).toEqual(["a", "b", "c"]);
    expect(await result.text).toBe("abc");
  });

  it("streams a plain string as one delta", async () => {
    const result = streamText({ model: scriptedLanguageModel("whole"), prompt: "hi" });
    expect(await result.text).toBe("whole");
  });

  it("advances the script the same way generate does", async () => {
    const model = scriptedLanguageModel("first", "second");

    expect(await streamText({ model, prompt: "hi" }).text).toBe("first");
    expect(await streamText({ model, prompt: "hi" }).text).toBe("second");
  });
});

describe("a scripted TOOL CALL — the strict tool-use path (W4 pipeline)", () => {
  it("answers generateText with a forced tool call carrying its input", async () => {
    const model = scriptedLanguageModel({ tool: "repair", input: { fix: "add the Disclaimer" } });

    const result = await generateText({ model, prompt: "repair it" });

    expect(result.toolCalls.map(({ toolName }) => toolName)).toEqual(["repair"]);
    expect(result.toolCalls[0]?.input).toEqual({ fix: "add the Disclaimer" });
  });

  it("answers streamText with the same tool call", async () => {
    const model = scriptedLanguageModel({ tool: "outline", input: { sections: 2 } });

    const result = streamText({ model, prompt: "outline it" });
    // Drain the stream so the call settles.
    for await (const _delta of result.textStream) { /* no text on a tool turn */ }

    expect((await result.toolCalls).map(({ toolName }) => toolName)).toEqual(["outline"]);
    expect((await result.toolCalls)[0]?.input).toEqual({ sections: 2 });
  });

  it("finishes as tool-calls rather than stop, so a caller can tell the two apart", async () => {
    const result = await generateText({
      model: scriptedLanguageModel({ tool: "repair", input: {} }),
      prompt: "repair it",
    });

    expect(result.finishReason).toBe("tool-calls");
  });

  it("advances the script, so a tool turn can be followed by a text turn", async () => {
    const model = scriptedLanguageModel({ tool: "repair", input: {} }, "done");

    await generateText({ model, prompt: "repair it" });

    expect((await ask(model)).text).toBe("done");
  });
});

describe("basicLanguageModel — valid generation for suites that only need an app", () => {
  it("derives a create's app name from the user request", async () => {
    const result = await generateText({ model: basicLanguageModel(), prompt: "USER_REQUEST: Invoice Chaser" });

    expect(result.text).toContain('name="Invoice Chaser"');
  });

  it("strips quotes that would break the name attribute", async () => {
    const result = await generateText({
      model: basicLanguageModel(),
      prompt: 'USER_REQUEST: Call it "Q3"',
    });

    expect(result.text).toContain("Call it 'Q3'");
  });

  it("caps a long name inside the display-title limit", async () => {
    const result = await generateText({
      model: basicLanguageModel(),
      prompt: `USER_REQUEST: ${"x".repeat(120)}`,
    });

    const name = /name="([^"]*)"/.exec(result.text)?.[1] ?? "";
    expect(name.length).toBe(40);
  });

  it("falls back to a placeholder when the prompt carries no marker at all", async () => {
    const result = await generateText({ model: basicLanguageModel(), prompt: "no markers here" });

    expect(result.text).toContain('name="Untitled app"');
  });

  it("falls back to a placeholder when the marker is present but empty", async () => {
    const result = await generateText({ model: basicLanguageModel(), prompt: "USER_REQUEST: \nnext line" });

    expect(result.text).toContain('name="Untitled app"');
  });

  it("emits a Disclaimer, so the fixture clears the empty-document gate", async () => {
    const result = await generateText({ model: basicLanguageModel(), prompt: "USER_REQUEST: Spend" });

    expect(result.text).toContain("<Disclaimer");
  });
});
