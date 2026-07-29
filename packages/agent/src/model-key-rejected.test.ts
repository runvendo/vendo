import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "./index.js";
import { boundRegistry, ctx, readSse, testGuard } from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The wire error frame a turn produces when the model call throws. */
async function errorFrameFor(error: unknown): Promise<string | undefined> {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const model = new MockLanguageModelV3({
    doStream: async () => { throw error; },
  });
  const guard = testGuard({});
  const agent = createAgent({ model, tools: boundRegistry({}, guard), guard });
  const response = await agent.stream({
    threadId: "thr_key_rejected",
    message: { id: "user_401", role: "user", parts: [{ type: "text", text: "hi" }] },
    ctx: ctx(),
  });
  const { parts } = await readSse(response);
  return parts.find((part) => part.type === "error")?.errorText as string | undefined;
}

describe("a rejected model key (401) reaches the thread with a next step", () => {
  it("names both exits without prescribing the wrong one, for a host-wired provider", async () => {
    // A gateway/provider 401 arrives as an APICallError-shaped throw, never as
    // a VendoError. The rung is unknowable for a provider vendo did not build
    // (the documented Worker wiring points the stock Anthropic provider at the
    // Cloud gateway), so the sentence covers both keys.
    const errorText = await errorFrameFor(Object.assign(new Error("Unauthorized"), {
      statusCode: 401,
      responseBody: JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }),
    }));
    expect(errorText).toBe(
      "Vendo: the model provider rejected the API key (401). On a Vendo Cloud key, run `vendo login` to mint a fresh "
      + "VENDO_API_KEY; on your own provider key, check it in .env.local. (validation)",
    );
    // The provider's own body never travels.
    expect(errorText).not.toContain("x-api-key");
  });

  it("leaves a 401 that carries the meter refusal to the pricing rail's richer sentence", async () => {
    const errorText = await errorFrameFor(Object.assign(new Error("Unauthorized"), {
      statusCode: 401,
      responseBody: JSON.stringify({ code: "meter-exhausted", meter: "ai_tokens" }),
    }));
    expect(errorText).toBe(
      "Vendo: Vendo Cloud paused AI tokens — the allowance for this billing period is used up. "
      + "Upgrade your plan or bring your own infrastructure. (cloud-required)",
    );
  });

  it("keeps the generic line for a non-401 provider failure", async () => {
    const errorText = await errorFrameFor(Object.assign(new Error("Internal Server Error"), { statusCode: 500 }));
    expect(errorText).toBe("An error occurred while generating the response.");
  });
});
