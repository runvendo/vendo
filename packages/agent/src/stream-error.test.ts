import { VendoError } from "@vendoai/core";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  readSse,
  scriptedModel,
  testGuard,
  textTurn,
  toolCallTurn,
  userMessage,
} from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function streamWithThrowingModel(error: unknown): Promise<{
  parts: Array<Record<string, unknown>>;
  logged: unknown[][];
}> {
  const logged: unknown[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args); });
  const model = new MockLanguageModelV3({
    doStream: async () => { throw error; },
  });
  const guard = testGuard();
  const agent = createAgent({ model, tools: boundRegistry({}, guard), guard });
  const response = await agent.stream({
    threadId: "thr_stream_error",
    message: { id: "user_err", role: "user", parts: [{ type: "text", text: "hi" }] },
    ctx: ctx(),
  });
  const { parts } = await readSse(response);
  return { parts, logged };
}

describe("mid-stream turn errors", () => {
  it("a VendoError travels as a recognizable, safe error part and is logged server-side", async () => {
    const { parts, logged } = await streamWithThrowingModel(
      new VendoError("cloud-required", "this deployment's plan does not include app machines"),
    );
    const errorPart = parts.find((part) => part.type === "error");
    expect(errorPart).toBeDefined();
    expect(errorPart?.errorText).toBe("Vendo: this deployment's plan does not include app machines (cloud-required)");
    expect(logged.some((args) => String(args[0]).includes("[vendo] turn stream error"))).toBe(true);
  });

  it("the gateway's meter-exhausted 402 travels as OUR crafted refusal sentence (pricing v3 §5)", async () => {
    // The Cloud model gateway refuses exhausted meters with HTTP 402 and the
    // structured body; @ai-sdk providers surface that as an APICallError-shaped
    // throw carrying the raw body — never a VendoError.
    const { parts, logged } = await streamWithThrowingModel(Object.assign(new Error("Payment Required"), {
      statusCode: 402,
      responseBody: JSON.stringify({
        code: "meter-exhausted",
        meter: "ai_tokens",
        used: 1_204_000,
        limit: 1_000_000,
        resets_at: "2026-08-01T00:00:00.000Z",
        reason: "allowance",
        exits: { upgrade_url: "https://console.vendo.run/billing", byo_docs_url: "https://docs.vendo.run/byo" },
      }),
    }));
    const errorPart = parts.find((part) => part.type === "error");
    expect(errorPart?.errorText).toBe(
      "Vendo: Vendo Cloud paused AI tokens — the allowance for this billing period is used up "
      + "(1,204,000 of 1,000,000 used; resets 2026-08-01). "
      + "Upgrade your plan (https://console.vendo.run/billing) "
      + "or bring your own infrastructure (https://docs.vendo.run/byo). (cloud-required)",
    );
    expect(logged.some((args) => String(args[0]).includes("[vendo] turn stream error"))).toBe(true);
  });

  it("an unknown meter still renders honestly under the raw-id fallback", async () => {
    const { parts } = await streamWithThrowingModel(Object.assign(new Error("Payment Required"), {
      statusCode: 402,
      responseBody: JSON.stringify({ code: "meter-exhausted", meter: "holo_decks" }),
    }));
    const errorPart = parts.find((part) => part.type === "error");
    expect(errorPart?.errorText).toBe(
      "Vendo: Vendo Cloud paused holo_decks — the allowance for this billing period is used up. "
      + "Upgrade your plan or bring your own infrastructure. (cloud-required)",
    );
  });

  it("a non-refusal 402 body stays the fixed generic string (no raw provider text leaks)", async () => {
    const { parts } = await streamWithThrowingModel(Object.assign(new Error("Payment Required at key=sk-123"), {
      statusCode: 402,
      responseBody: JSON.stringify({ error: { code: "insufficient_quota", message: "internal key=sk-123" } }),
    }));
    const errorPart = parts.find((part) => part.type === "error");
    expect(errorPart?.errorText).toBe("An error occurred while generating the response.");
  });

  it("the failed turn CARRIES the error: a data-vendo-turn-error part beside the transient error chunk", async () => {
    // self-serve P — the ai-SDK error chunk belongs to no message, so a
    // reloaded thread showed the question answered by a blank assistant turn.
    // The same gated string rides the turn as a part, which persists.
    const { parts } = await streamWithThrowingModel(
      new VendoError("validation", "Vendo found no model key. Run `vendo login` for a free dev key."),
    );
    const notices = parts.filter((part) => part.type === "data-vendo-turn-error");
    expect(notices).toHaveLength(1);
    expect((notices[0]?.data as { message?: string }).message)
      .toBe("Vendo: Vendo found no model key. Run `vendo login` for a free dev key. (validation)");
  });

  it("an unknown error's turn part stays the fixed generic string too (no internals in the persisted turn)", async () => {
    const { parts } = await streamWithThrowingModel(new Error("ECONNRESET at https://provider.internal/key=sk-123"));
    const notice = parts.find((part) => part.type === "data-vendo-turn-error");
    expect((notice?.data as { message?: string }).message).toBe("An error occurred while generating the response.");
    expect(JSON.stringify(notice)).not.toContain("sk-123");
  });

  it("an unknown error stays the fixed generic string (raw internals never reach the wire) but still logs", async () => {
    const { parts, logged } = await streamWithThrowingModel(new Error("ECONNRESET at https://provider.internal/key=sk-123"));
    const errorPart = parts.find((part) => part.type === "error");
    expect(errorPart).toBeDefined();
    expect(errorPart?.errorText).toBe("An error occurred while generating the response.");
    expect(String(errorPart?.errorText)).not.toContain("sk-123");
    expect(logged.some((args) => String(args[0]).includes("[vendo] turn stream error"))).toBe(true);
  });
});

describe("recoverable tool errors are NOT turn failures (checker round, blocker 1)", () => {
  const descriptor = {
    name: "echo",
    description: "Echo the input back",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    risk: "read" as const,
  };

  it("a hallucinated tool name the model recovers from leaves no turn-error part", async () => {
    // The ai-SDK's `onError` is a general error-TEXT formatter: it also runs
    // for the recoverable `tool-input-error` chunk a bad tool name produces.
    // The SDK feeds that back and the model answers on the next step, so the
    // finished turn must carry the answer and nothing else — a notice here
    // would render a permanent failed-beat alert above a successful reply.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const guard = testGuard({});
    const tools = boundRegistry({ echo: { descriptor, execute: async (args) => args } }, guard);
    const model = scriptedModel([
      toolCallTurn("no_such_tool", { value: "x" }, "call_bogus"),
      textTurn("Here is your dashboard.", "text_ok"),
    ]);
    const agent = createAgent({ model, tools, guard });

    const response = await agent.stream({
      threadId: "thr_recoverable",
      message: userMessage("u_recoverable", "Show me a dashboard"),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(parts.some((part) => part.type === "tool-input-error")).toBe(true);
    expect(parts.filter((part) => part.type === "data-vendo-turn-error")).toHaveLength(0);
    const stored = await agent.threads.get("thr_recoverable", ctx());
    const assistant = stored?.messages.at(-1);
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.parts.some((part) => part.type === "data-vendo-turn-error")).toBe(false);
  });

  it("a tool that throws mid-turn leaves no turn-error part either", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const guard = testGuard({});
    const tools = boundRegistry({
      echo: { descriptor, execute: async () => { throw new Error("upstream 500"); } },
    }, guard);
    const model = scriptedModel([
      toolCallTurn("echo", { value: "x" }, "call_throws"),
      textTurn("Recovered without it.", "text_recovered"),
    ]);
    const agent = createAgent({ model, tools, guard });

    const response = await agent.stream({
      threadId: "thr_tool_throw",
      message: userMessage("u_tool_throw", "Echo something"),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    expect(parts.filter((part) => part.type === "data-vendo-turn-error")).toHaveLength(0);
  });
});

describe("a retry never inherits the failed turn's notice (checker round, blocker 2)", () => {
  it("the flagship keyless → key → Retry flow persists a clean assistant message", async () => {
    // The stored thread still ends with the errored assistant turn when the
    // retry arrives, and the ai-SDK CONTINUES a trailing assistant message —
    // so the successful answer used to land under the stale "no model key"
    // line and persist that way forever.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    let keyed = false;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        if (!keyed) throw new VendoError("validation", "Vendo found no model key.");
        return { stream: simulateReadableStream({ chunks: textTurn("Here is your dashboard.", "text_after_key") }) };
      },
    });
    const agent = createAgent({ model, tools, guard });
    const threadId = "thr_retry_clean";
    const ask = userMessage("u_retry", "Show me a dashboard");

    await readSse(await agent.stream({ threadId, message: ask, ctx: ctx() }));
    const failed = (await agent.threads.get(threadId, ctx()))?.messages.at(-1);
    expect(failed?.parts.some((part) => part.type === "data-vendo-turn-error")).toBe(true);

    // `vendo login` lands the key; the banner's Retry re-issues the same user turn.
    keyed = true;
    await readSse(await agent.stream({ threadId, message: ask, ctx: ctx() }));

    // What a reload reads back. Asserted over the WHOLE thread, not just the
    // last message: persistence merges by message id and can only add or
    // replace, so a failed turn left behind in the store would sit ABOVE the
    // answer and never show up in a tail-only check (it didn't — the browser
    // caught it). One user turn, one assistant turn, no notice anywhere.
    const stored = await agent.threads.get(threadId, ctx());
    expect(stored?.messages.flatMap((message) => message.parts)
      .filter((part) => part.type === "data-vendo-turn-error")).toHaveLength(0);
    expect(stored?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(stored?.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    const assistant = stored?.messages.at(-1);
    expect(assistant?.parts.some((part) => part.type === "text" && part.text === "Here is your dashboard.")).toBe(true);
  });
});

describe("failures thrown before the model stream exists (checker round, finding 3)", () => {
  it("a turn that dies building its toolset still records why, instead of persisting blank", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args); });
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    // descriptors() is read while the toolset is assembled — well before
    // streamText exists, so this never reaches the model stream's error chunk.
    tools.descriptors = async () => { throw new VendoError("validation", "the tool catalog is unreadable"); };
    const agent = createAgent({ model: new MockLanguageModelV3({}), tools, guard });

    const response = await agent.stream({
      threadId: "thr_prestream",
      message: userMessage("u_prestream", "hi"),
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    const notice = parts.find((part) => part.type === "data-vendo-turn-error");
    expect((notice?.data as { message?: string }).message)
      .toBe("Vendo: the tool catalog is unreadable (validation)");
    expect(parts.find((part) => part.type === "error")?.errorText)
      .toBe("Vendo: the tool catalog is unreadable (validation)");
    // Exactly one notice: the SDK runs the gate again over its own error text
    // while assembling the message to persist, so the record is once-guarded.
    expect(parts.filter((part) => part.type === "data-vendo-turn-error")).toHaveLength(1);
    expect(logged.some((args) => String(args[0]).includes("[vendo] turn stream error"))).toBe(true);
  });
});
