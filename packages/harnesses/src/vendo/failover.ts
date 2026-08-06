/**
 * Ordered provider failover, at the FIRST BYTE and no later.
 *
 * Why it lives at the model seam rather than around `streamText`: `streamText`
 * does not throw a provider failure — the default `onError` logs it and the text
 * stream simply ends, so callers tap the `error` chunk instead. A try/catch
 * around the call would therefore never see the failure it is meant to recover
 * from, and peeking the result's stream to check is not available either
 * (`toUIMessageStream()` and `fullStream` read the same source once, so a peek
 * upstream of the caller would eat the answer). One rung DOWN, at `doStream`, the
 * failure is a rejection or a first `error` part and the stream is still ours to
 * hand on.
 *
 * The boundary is first byte, deliberately. A provider that fails before
 * producing output produced nothing anyone saw, so the next rung can serve the
 * whole answer. Once output is streaming, switching would emit a second answer
 * on top of half of a first one, so the failure travels to the caller's existing
 * error path instead. There is no partial-replay mode and there should not be.
 *
 * Nothing here classifies a failure by ORIGIN or reshapes its message: the last
 * rung's own error is rethrown untouched, so `wireErrorMessage` sees exactly what
 * it sees today and keeps knowing the shape and never the origin.
 */
import type { LanguageModel } from "ai";

/** A model this can wrap. `LanguageModel` also admits a provider-id string, and a
 *  string has no `doStream` to fall over. */
export type ResolvedModel = Extract<LanguageModel, { specificationVersion: "v3" }>;

type StreamResult = Awaited<ReturnType<ResolvedModel["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

/** Parts that carry no model OUTPUT: warnings and response metadata arrive before
 *  the model has said anything, so a failure after them is still a failure at the
 *  first byte. */
const PREAMBLE = new Set(["stream-start", "response-metadata"]);

/** Re-serve the parts already read, then the rest of the same stream. */
function replay(buffered: StreamPart[], reader: ReadableStreamDefaultReader<StreamPart>): ReadableStream<StreamPart> {
  return new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of buffered) controller.enqueue(part);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** One rung: call it, and read up to (and including) its first OUTPUT part so a
 *  failure that early can still be someone else's turn to serve. */
async function attempt(model: ResolvedModel, options: Parameters<ResolvedModel["doStream"]>[0]): Promise<StreamResult> {
  const result = await model.doStream(options);
  const reader = result.stream.getReader();
  const buffered: StreamPart[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered.push(value);
      if (value.type === "error") throw value.error;
      if (!PREAMBLE.has(value.type)) break;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return { ...result, stream: replay(buffered, reader) };
}

/**
 * The ordered ladder as ONE model, so every caller downstream — `streamText`, its
 * retry budget, its step loop — is unchanged and unaware.
 */
export function failoverModel(ladder: readonly [ResolvedModel, ...ResolvedModel[]]): ResolvedModel {
  const [primary] = ladder;
  const walk = async <T>(
    options: { abortSignal?: AbortSignal },
    call: (model: ResolvedModel) => PromiseLike<T>,
  ): Promise<T> => {
    let last: unknown;
    for (const model of ladder) {
      try {
        return await call(model);
      } catch (error) {
        // The ONE classification, and it is not about the error's origin: a
        // cancelled turn is not a failed provider. Without this, one hang-up
        // calls every provider the host configured.
        if (options.abortSignal?.aborted === true) throw error;
        last = error;
      }
    }
    throw last;
  };
  return {
    specificationVersion: "v3",
    provider: primary.provider,
    modelId: primary.modelId,
    get supportedUrls() {
      return primary.supportedUrls;
    },
    doGenerate: (options) => walk(options, (model) => model.doGenerate(options)),
    doStream: (options) => walk(options, (model) => attempt(model, options)),
  };
}
