/**
 * Ported from `@vendoai/agent`'s provider-401.test.ts, which died with the
 * legacy door (S6). The law is unchanged, and it now has to hold on the runtime
 * that replaced that door: ONE gate (`wireErrorMessage`) decides what a failed
 * turn tells the user, and it knows the SHAPE of a failure, never its ORIGIN —
 * so a raw provider 401 stays generic, while the errors Vendo itself crafted
 * (the credential ladder's `vendo login` guidance, the Cloud meter refusal)
 * travel intact, with their code.
 *
 * The runtime used to substitute its own constant for every failure the
 * harness's event loop could not report as an `error` event, so a keyless
 * deployment migrated onto the harness path lost the one sentence that said
 * what to do about it — and, because that constant was spoken as prose, kept no
 * record of the failure at all.
 */
import { VendoError, type ThreadId } from "@vendoai/core";
import { APICallError } from "ai";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineHarness } from "./define.js";
import { createHarnessRuntime } from "./runtime.js";
import {
  boundRegistry,
  ctx,
  readSse,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  unusedModels,
  userMessage,
} from "./test-doubles.test-util.js";

const THREAD = "thr_provider_401" as ThreadId;

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

/** What the credential ladder raises when no model key resolved: a VendoError,
 *  because only the ladder knows the call was the MODEL's and can name the fix.
 *  Reproduced rather than imported — @vendoai/vendo sits above this package. */
const KEYLESS = new VendoError(
  "validation",
  "Vendo found no model key. Set ANTHROPIC_API_KEY in .env.local, or run `vendo login` for a free dev key.",
);

/** Both carriers of a failed turn: the transient ai-SDK `error` chunk (the
 *  screen's banner + Retry) and the persisted `data-vendo-turn-error` part (what
 *  a reload shows). The legacy door put the SAME sentence on both. */
async function failedTurn(
  where: "harness" | "before-the-harness",
  error: unknown,
): Promise<{ streamed?: string; persisted?: string; raw: string }> {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const guard = testGuard();
  const transcript = testTranscript();
  const runtime = createHarnessRuntime({
    tools: boundRegistry({}, guard),
    guard,
    skills: testSkills(),
    transcript,
    ...(where === "before-the-harness"
      ? { liveTurn: () => { throw error; } }
      : {}),
  });
  const harness = defineHarness({
    name: "throws",
    async *run() {
      if (where === "harness") throw error;
      yield { type: "text", delta: "hi" };
    },
  });
  const parts = await readSse(await runtime.run({
    harness,
    threadId: THREAD,
    messages: [userMessage("m1", "go")] as UIMessage[],
    ctx: ctx(),
    workspace: testWorkspace(),
    models: unusedModels(),
    interactive: true,
  }));
  const stored = await transcript.list(ctx().principal, THREAD);
  const notice = stored
    .flatMap((message) => message.parts)
    .find((part) => part.type === "data-vendo-turn-error");
  return {
    streamed: parts.find((part) => part.type === "error")?.errorText as string | undefined,
    persisted: (notice as { data?: { message?: string } } | undefined)?.data?.message,
    raw: JSON.stringify({ parts, stored }),
  };
}

/** The runtime's own consumer-voice sentence for a failure it cannot name — the
 *  legacy door's wording was "An error occurred while generating the response.";
 *  the wording is the only thing that differs, and it is the runtime's shipped
 *  voice (runtime.ts `HARNESS_FAILED`), deliberately kept. */
const UNNAMEABLE = "Something went wrong on my side, so I stopped.";

describe("a provider 401 on the harness path", () => {
  it("keeps the generic line: this gate knows the SHAPE, never the ORIGIN", async () => {
    // Deliberate. The ladder wraps the 401s it can attribute — it knows which
    // rung it resolved. Everything else is a guess: a connector's descriptors()
    // 401 would send an operator to re-mint a model key for the wrong system.
    const refused = unauthorized({ error: { type: "authentication_error", message: "invalid x-api-key" } });
    for (const where of ["harness", "before-the-harness"] as const) {
      const turn = await failedTurn(where, refused);
      expect(turn.streamed, where).toBe(UNNAMEABLE);
      expect(turn.persisted, where).toBe(UNNAMEABLE);
      // The url, the key hint and the provider body never travel.
      expect(turn.raw, where).not.toContain("api.anthropic.com");
      expect(turn.raw, where).not.toContain("x-api-key");
    }
  });

  it("still renders the pricing sentence for a 401 that carries the meter refusal", async () => {
    // The refusal BODY is self-identifying (pricing v3 §5), so this one needs no
    // guess about origin: the structured fields are the source of truth.
    const sentence = "Vendo: Vendo Cloud paused usage — the allowance for this billing period is used up. "
      + "Upgrade your plan or bring your own infrastructure. (cloud-required)";
    for (const where of ["harness", "before-the-harness"] as const) {
      const turn = await failedTurn(where, unauthorized({ code: "meter-exhausted", meter: "usage", unit: "usd" }));
      expect(turn.streamed, where).toBe(sentence);
      expect(turn.persisted, where).toBe(sentence);
    }
  });
});

describe("the credential ladder's fix survives the fold", () => {
  it("a keyless turn is told to run `vendo login`, whichever half of the turn died", async () => {
    // The regression this file exists for: the runtime answered every escaped
    // failure with its own constant, so the one deployment that needs guidance
    // most — a host with no model key at all — was told nothing actionable.
    for (const where of ["harness", "before-the-harness"] as const) {
      const turn = await failedTurn(where, KEYLESS);
      expect(turn.streamed, where).toBe(`Vendo: ${KEYLESS.message} (validation)`);
      expect(turn.persisted, where).toBe(`Vendo: ${KEYLESS.message} (validation)`);
    }
  });
});
