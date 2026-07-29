import type { ToolRegistry } from "@vendoai/core";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "./index.js";
import { boundRegistry, ctx, readSse, testGuard } from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The real ai-SDK provider failure shape for an HTTP status. */
function apiCallError(statusCode: number, responseBody: string): APICallError {
  return new APICallError({
    message: "Unauthorized",
    url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: {},
    statusCode,
    responseHeaders: { "request-id": "req_diagnostic" },
    responseBody,
  });
}

/** The wire error frame a turn produces — from the model call, or from the tool
 *  registry the turn consults while assembling its toolset. */
async function errorFrameFor(
  error: unknown,
  origin: "model" | "tools" = "model",
): Promise<string | undefined> {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const model = new MockLanguageModelV3({
    doStream: async () => { throw error; },
  });
  const failingTools: ToolRegistry = {
    descriptors: async () => { throw error; },
    execute: async () => ({ status: "ok", output: null }),
  };
  const guard = testGuard({});
  const agent = createAgent({
    model,
    tools: origin === "tools" ? failingTools : boundRegistry({}, guard),
    guard,
  });
  const response = await agent.stream({
    threadId: "thr_provider_401",
    message: { id: "user_401", role: "user", parts: [{ type: "text", text: "hi" }] },
    ctx: ctx(),
  });
  const { parts } = await readSse(response);
  return parts.find((part) => part.type === "error")?.errorText as string | undefined;
}

describe("a provider 401 at the wire gate", () => {
  it("keeps the generic line: this gate knows the error SHAPE, never its ORIGIN", async () => {
    // Deliberate. The credential ladder wraps the 401s it can attribute — it
    // knows which rung it resolved — and those arrive here as VendoErrors
    // carrying that rung's fix. Where the origin is unknowable, model-key
    // advice would be a guess, so the real error goes to the server log only.
    const errorText = await errorFrameFor(apiCallError(
      401,
      JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }),
    ));
    expect(errorText).toBe("An error occurred while generating the response.");
    expect(errorText).not.toContain("x-api-key");
  });

  it("never mistakes a TOOL's 401 for the model key's", async () => {
    // A connector's descriptors() failing with a genuine provider-shaped 401
    // reaches this same gate. Telling that operator to re-mint a model key
    // would send them to the wrong system entirely.
    const errorText = await errorFrameFor(apiCallError(401, JSON.stringify({ error: "token expired" })), "tools");
    expect(errorText).toBe("An error occurred while generating the response.");
    expect(errorText).not.toContain("vendo login");
  });

  it("still renders the pricing sentence for a 401 that carries the meter refusal", async () => {
    // The refusal BODY is self-identifying (pricing v3 §5), so this one needs
    // no guess about origin: the structured fields are the source of truth.
    const errorText = await errorFrameFor(apiCallError(
      401,
      JSON.stringify({ code: "meter-exhausted", meter: "ai_tokens" }),
    ));
    expect(errorText).toBe(
      "Vendo: Vendo Cloud paused AI tokens — the allowance for this billing period is used up. "
      + "Upgrade your plan or bring your own infrastructure. (cloud-required)",
    );
  });
});
