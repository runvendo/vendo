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

  it("an unknown error stays the fixed generic string (raw internals never reach the wire) but still logs", async () => {
    const { parts, logged } = await streamWithThrowingModel(new Error("ECONNRESET at https://provider.internal/key=sk-123"));
    const errorPart = parts.find((part) => part.type === "error");
    expect(errorPart).toBeDefined();
    expect(errorPart?.errorText).toBe("An error occurred while generating the response.");
    expect(String(errorPart?.errorText)).not.toContain("sk-123");
    expect(logged.some((args) => String(args[0]).includes("[vendo] turn stream error"))).toBe(true);
  });
});
