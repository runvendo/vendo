/**
 * An open-source contender has to be nameable in `--models` AND billable in the
 * same table as the rest. `usdFor` throws for a model it holds no price for, so
 * an alias shipped without its pricing row would end its own run at the first
 * result rather than at a missing row somebody could see and fix.
 */
import { describe, expect, it } from "vitest";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, stepCountIs, streamText, tool } from "ai";
import { CODEX_MODEL_IDS, meteredModel, MODEL_IDS, OPENROUTER_MODEL_IDS, usdFor, WAFER_MODEL_IDS, type UsageTotals } from "../src/meter.js";

const perMTok: UsageTotals = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  calls: 1,
};

describe("the Wafer contenders", () => {
  it("names each alias by the id Wafer serves it under", () => {
    expect(MODEL_IDS["glm-fast"]).toBe("glm5.2-fast");
    expect(MODEL_IDS["deepseek-flash"]).toBe("DeepSeek-V4-Flash-0731-Fast");
  });

  it("prices every one of them, so no Wafer run is ended by a missing row", () => {
    for (const id of Object.values(WAFER_MODEL_IDS)) expect(usdFor(perMTok, id)).toBeGreaterThan(0);
  });

  /** Wafer's own `GET /v1/models` quote, in dollars per million tokens. */
  it("charges what Wafer quotes", () => {
    expect(usdFor(perMTok, "glm5.2-fast")).toBeCloseTo(2.1 + 6.6, 6);
    expect(usdFor(perMTok, "DeepSeek-V4-Flash-0731-Fast")).toBeCloseTo(0.28 + 0.56, 6);
  });
});

/**
 * The cross-vendor row is only an answer to buy-versus-build if the three
 * columns cost the same to run: a flagship set against another vendor's mid-tier
 * measures a price tag, not a product. So the band is pinned here rather than
 * left to whoever next edits an id — and the codex column, which buys its own
 * engine from OpenAI directly, is pinned onto the same band beside them.
 */
describe("one price band", () => {
  it("names each alias by the id its door serves it under", () => {
    expect(OPENROUTER_MODEL_IDS).toEqual({
      claude: "anthropic/claude-sonnet-5",
      gpt: "openai/gpt-5.6-terra",
      gemini: "google/gemini-3.1-pro-preview",
    });
    expect(CODEX_MODEL_IDS).toEqual({ terra: "gpt-5.6-terra" });
  });

  /** Sonnet 5 at $2/$10 and Gemini 3.1 Pro at $2/$12 are their vendors' rates as
   *  the router quotes them. Terra lists at $2/$12 too — the codex row is that
   *  rate, and the router row is priced at the same list rate on purpose, not
   *  the router's temporary 50% discount, so a coupon that can expire any day
   *  can't flatter one column over the others it's compared against. */
  it("prices every alias in it, within a dollar of each other on input", () => {
    for (const id of [...Object.values(OPENROUTER_MODEL_IDS), ...Object.values(CODEX_MODEL_IDS)]) {
      expect(usdFor(perMTok, id)).toBeGreaterThan(0);
    }
    expect(usdFor(perMTok, MODEL_IDS.claude)).toBeCloseTo(2 + 10, 6);
    expect(usdFor(perMTok, MODEL_IDS.gemini)).toBeCloseTo(2 + 12, 6);
    expect(usdFor(perMTok, MODEL_IDS.terra)).toBeCloseTo(2 + 12, 6);
    expect(usdFor(perMTok, MODEL_IDS.gpt)).toBeCloseTo(2 + 12, 6);
  });
});

/**
 * A TURN THAT ENDED EARLY STILL BILLED.
 *
 * The screen agent hangs up on its own last stream from inside the final save's
 * tool call — the closing-words shortcut — and once it has, nothing downstream is
 * left to close or cancel the pipe. So `message_stop` never arrives, and
 * `message_stop` is the only place `@ai-sdk/anthropic` converts a stream's usage
 * into the `finish` part this meter used to be the only thing it read. The turn
 * that WROTE the screen billed as nothing: maple/rent-check, 133 output tokens
 * for a 2.3kB painted screen, in the column the whole benchmark is about.
 *
 * Through the REAL provider, the REAL `streamText` loop and a real SSE body,
 * because WHEN the wire states a count against when the caller lets go is the
 * entire question — a stubbed stream part would answer it by assumption.
 */
describe("a turn its own caller hangs up on", () => {
  const event = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  /** Anthropic states the input and cache counts once, up front… */
  const START = event("message_start", {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: MODEL_IDS.sonnet,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1_200, output_tokens: 3, cache_read_input_tokens: 800, cache_creation_input_tokens: 40 },
    },
  });
  /** …then the save the agent hangs up from, which the wire completes BEFORE it
   *  gets to the message's own last words. */
  const SAVE = event("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_1", name: "save", input: {} },
  })
    + event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"content":"a whole screen"}' },
    })
    + event("content_block_stop", { type: "content_block_stop", index: 0 });
  /** …and only here does it restate the output total it really spent. */
  const TAIL = event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 2_110 },
  }) + event("message_stop", { type: "message_stop" });

  /**
   * One turn whose `save` tool hangs up the way the screen agent's does — with
   * the tail either already on the wire when it does, or cut off by the hang-up
   * and never sent. Gated on the hang-up itself rather than on a timer, because
   * a timer would make the difference between the two a race.
   */
  const hungUpOn = async (tail: "delivered" | "never"): Promise<UsageTotals> => {
    const ended = new AbortController();
    let letGo = (): void => {};
    const hungUp = new Promise<void>((resolve) => { letGo = resolve; });
    const provider = createAnthropic({
      apiKey: "genbench-test",
      fetch: async () => new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(START + SAVE));
            if (tail === "never") await hungUp;
            else controller.enqueue(encoder.encode(TAIL));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    });
    const meter = meteredModel(provider(MODEL_IDS.sonnet), MODEL_IDS.sonnet);
    const run = streamText({
      model: meter.model,
      prompt: "write the screen",
      abortSignal: ended.signal,
      stopWhen: stepCountIs(4),
      tools: {
        save: tool({
          description: "save the screen",
          inputSchema: jsonSchema<{ content: string }>({
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
          }),
          execute: async () => {
            ended.abort();
            letGo();
            return "saved";
          },
        }),
      },
    });
    try {
      for await (const _part of run.fullStream) { /* the drive reads to the end, or to the hang-up */ }
    } catch { /* the hang-up */ }
    return meter.totals();
  };

  it("bills what the wire had already stated when nobody was left to read the finish", async () => {
    // Everything `message_start` said — the input and both cache counts, which
    // are most of this turn's dollars — instead of the nothing a missing
    // `finish` used to leave behind.
    expect(await hungUpOn("never")).toEqual({
      inputTokens: 1_200,
      outputTokens: 3,
      cacheReadTokens: 800,
      cacheWriteTokens: 40,
      calls: 1,
    });
  });

  it("bills a turn that got its finish exactly once, at the provider's own count", async () => {
    // The same turn, with the tail on the wire before the hang-up: the running
    // readings and the provider's final word are the SAME call, so the output
    // total is the provider's 2110 and not 2110 on top of them.
    expect(await hungUpOn("delivered")).toEqual({
      inputTokens: 1_200,
      outputTokens: 2_110,
      cacheReadTokens: 800,
      cacheWriteTokens: 40,
      calls: 1,
    });
  });

  /** The same floor the thinking split stands on, one describe down: a count is
   *  read off the wire or it does not exist. An estimate in this table would be
   *  worse than a gap, because a gap can be seen. */
  it("invents nothing for a stream that stated no usage at all", async () => {
    const provider = createAnthropic({
      apiKey: "genbench-test",
      fetch: async () => new Response(
        event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
          + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })
          + event("content_block_stop", { type: "content_block_stop", index: 0 }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    });
    const meter = meteredModel(provider(MODEL_IDS.sonnet), MODEL_IDS.sonnet);
    await streamText({ model: meter.model, prompt: "say hello" }).consumeStream();

    expect(meter.totals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 0,
    });
  });
});

/**
 * WHAT A TURN SPENT THINKING, BESIDE WHAT IT WROTE.
 *
 * `outputTokens` alone cannot answer whether a thinking budget bought anything:
 * a turn that thought for 1,800 tokens and wrote 310 bills exactly as one that
 * wrote 2,110 and thought about none of it. So the split is recorded — the
 * provider's own number where it keeps one, and NOTHING where it does not.
 *
 * Both halves are real providers over a stubbed wire, because which one
 * itemises thinking is the entire question: the OpenAI-compatible door states
 * `completion_tokens_details.reasoning_tokens`, and Anthropic states no such
 * field at all, so a 0 written beside an Anthropic turn would read as a model
 * that did not think.
 */
describe("the thinking half of an output", () => {
  const json = (body: unknown) => async (): Promise<Response> =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

  /** One completed turn through the router's OpenAI-compatible endpoint. */
  const throughTheRouter = async (usage: Record<string, unknown>): Promise<UsageTotals> => {
    const provider = createOpenAICompatible({
      name: "router",
      baseURL: "https://genbench.test/v1",
      apiKey: "genbench-test",
      fetch: json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: MODEL_IDS.gpt,
        choices: [{ index: 0, message: { role: "assistant", content: "a screen" }, finish_reason: "stop" }],
        usage,
      }),
    });
    const meter = meteredModel(provider(MODEL_IDS.gpt), MODEL_IDS.gpt);
    await generateText({ model: meter.model, prompt: "write the screen" });
    return meter.totals();
  };

  it("records what the provider says was thinking, as a split of the output already billed", async () => {
    // 1,800 of the 2,110 output tokens were thought rather than written — and
    // `outputTokens` is still the whole 2,110, because the split is not an
    // addend and no dollar figure may move for it.
    expect(
      await throughTheRouter({
        prompt_tokens: 1_200,
        completion_tokens: 2_110,
        completion_tokens_details: { reasoning_tokens: 1_800 },
      }),
    ).toEqual({
      inputTokens: 1_200,
      outputTokens: 2_110,
      reasoningTokens: 1_800,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 1,
    });
  });

  it("records the zero a provider states, which is a model that thought about nothing", async () => {
    const spent = await throughTheRouter({ prompt_tokens: 1_200, completion_tokens: 2_110 });

    expect(spent.reasoningTokens).toBe(0);
    expect(spent.outputTokens).toBe(2_110);
  });

  /** The gap, and why it is not a zero: Anthropic's usage block itemises no
   *  thinking, so `@ai-sdk/anthropic` reports `outputTokens.reasoning` as
   *  undefined for every call — and a 0 here would be this harness claiming a
   *  Sonnet turn did not think, which is a sentence about the model that would
   *  not be true. */
  it("says nothing at all for a provider that itemises no thinking", async () => {
    const provider = createAnthropic({
      apiKey: "genbench-test",
      fetch: json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: MODEL_IDS.sonnet,
        content: [{ type: "text", text: "a screen" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1_200, output_tokens: 2_110 },
      }),
    });
    const meter = meteredModel(provider(MODEL_IDS.sonnet), MODEL_IDS.sonnet);
    await generateText({ model: meter.model, prompt: "write the screen" });

    expect(meter.totals()).toEqual({
      inputTokens: 1_200,
      outputTokens: 2_110,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 1,
    });
    expect(meter.totals().reasoningTokens).toBeUndefined();
  });

  it("prices a turn the same whether or not its thinking was itemised", () => {
    expect(usdFor({ ...perMTok, reasoningTokens: 900_000 }, MODEL_IDS.gpt)).toBe(usdFor(perMTok, MODEL_IDS.gpt));
  });
});
