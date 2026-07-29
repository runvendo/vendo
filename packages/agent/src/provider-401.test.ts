import type { ToolRegistry } from "@vendoai/core";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "./index.js";
import { boundRegistry, ctx, readSse, testGuard } from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The real ai-SDK provider failure shape for a 401. */
function unauthorized(body: unknown): APICallError {
  return new APICallError({
    message: "Unauthorized",
    url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: {},
    statusCode: 401,
    responseBody: JSON.stringify(body),
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
  it("keeps the generic line whatever the origin: this gate knows the SHAPE, never the ORIGIN", async () => {
    // Deliberate. The credential ladder wraps the 401s it can attribute — it
    // knows which rung it resolved — and those arrive here as VendoErrors
    // carrying that rung's fix. Everything else is a guess: a connector's
    // descriptors() 401 reaching this same gate would send an operator to
    // re-mint a model key for the wrong system entirely.
    const refused = unauthorized({ error: { type: "authentication_error", message: "invalid x-api-key" } });
    for (const origin of ["model", "tools"] as const) {
      expect(await errorFrameFor(refused, origin), origin).toBe("An error occurred while generating the response.");
    }
  });

  it("still renders the pricing sentence for a 401 that carries the meter refusal", async () => {
    // The refusal BODY is self-identifying (pricing v3 §5), so this one needs
    // no guess about origin: the structured fields are the source of truth.
    const errorText = await errorFrameFor(unauthorized({ code: "meter-exhausted", meter: "ai_tokens" }));
    expect(errorText).toBe(
      "Vendo: Vendo Cloud paused AI tokens — the allowance for this billing period is used up. "
      + "Upgrade your plan or bring your own infrastructure. (cloud-required)",
    );
  });
});
