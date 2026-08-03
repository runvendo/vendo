import { VendoError } from "@vendoai/core";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "./index.js";
import { boundRegistry, ctx, readSse, testGuard } from "./test-helpers.js";

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
    const notice = parts.find((part) => part.type === "data-vendo-turn-error");
    expect(notice).toBeDefined();
    expect((notice?.data as { message?: string }).message)
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
