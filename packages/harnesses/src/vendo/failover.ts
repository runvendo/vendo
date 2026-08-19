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

/** What the ladder itself reads off a call. The rest of a spec's call options
 *  travels to the rung that was asked for it, unread. */
interface CallOptions {
  abortSignal?: AbortSignal;
}

/** The only part of a stream this reads: which KIND it is, and — for the one kind
 *  that carries a failure — what failed. Everything else rides through untouched,
 *  which is why the spec majors' differing payloads never come up here. */
interface StreamPart {
  type: string;
  error?: unknown;
}

interface StreamResult {
  stream: ReadableStream<StreamPart>;
}

/** A model this can wrap: any RESOLVED language model, on either live AI SDK
 *  major (ai@6's v3 spec, ai@7's v3 or v4). Described structurally rather than as
 *  the SDK's own union, because a union of two spec majors turns every signature
 *  above into an intersection no real model satisfies — and the ladder needs none
 *  of what differs between them. `LanguageModel` also admits a provider-id
 *  string, and a string has no `doStream` to fall over. */
export interface ResolvedModel {
  readonly specificationVersion: string;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>;
  doGenerate(options: CallOptions): PromiseLike<unknown>;
  doStream(options: CallOptions): PromiseLike<StreamResult>;
}

/** Parts that carry no model OUTPUT: warnings and response metadata arrive before
 *  the model has said anything, so a failure after them is still a failure at the
 *  first byte. */
const PREAMBLE = new Set(["stream-start", "response-metadata"]);

/** Re-serve the parts already read, then the rest of the same stream. */
function replay<Part>(buffered: Part[], reader: ReadableStreamDefaultReader<Part>): ReadableStream<Part> {
  return new ReadableStream<Part>({
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
async function attempt(model: ResolvedModel, options: CallOptions): Promise<StreamResult> {
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
export function failoverModel(ladder: readonly [ResolvedModel, ...ResolvedModel[]]): LanguageModel {
  const [primary] = ladder;
  const walk = async <T>(
    options: CallOptions,
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
  // The ladder answers as the PRIMARY's own spec version, because that is the
  // shape the SDK will then call it in — and every rung is that same shape by
  // construction. The cast says exactly that: this literal is a model of
  // whichever spec the primary already is.
  return {
    specificationVersion: primary.specificationVersion,
    provider: primary.provider,
    modelId: primary.modelId,
    get supportedUrls() {
      return primary.supportedUrls;
    },
    doGenerate: (options: CallOptions) => walk(options, (model) => model.doGenerate(options)),
    doStream: (options: CallOptions) => walk(options, (model) => attempt(model, options)),
  } as unknown as LanguageModel;
}
