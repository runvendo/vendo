import { VendoError } from "@vendoai/core";
import type { LanguageModel } from "ai";

/** The inference adapter seam (cloud definition 2026-07-17, adapter rule).
 * The agent and apps blocks consume exactly one interface — an ai-SDK
 * LanguageModel (03-agent §1) — so that IS the adapter interface; no grander
 * abstraction exists. BYO is the host's own model passed to
 * createVendo({ model }) (unchanged). This module ships the other two
 * implementations: `cloudModel`, a thin client against the Vendo Cloud
 * console's inference endpoint, and the fail-closed `unconfiguredModel`.
 * Which one composes is decided at the seam (selectModel in server.ts),
 * never in here — the adapters read no environment. */

/** Structural twin of the ai-SDK v3 model spec (same shape dev-creds/model.ts
 * uses): the umbrella implements the wire without importing provider code. */
interface LanguageModelV3Like {
  specificationVersion: "v3";
  provider: string;
  modelId: string;
  supportedUrls: Record<string, RegExp[]>;
  doGenerate(options: unknown): PromiseLike<unknown>;
  doStream(options: unknown): PromiseLike<unknown>;
}

export interface CloudModelOptions {
  apiKey: string;
  /** Defaults to the Vendo console; the composition seam passes VENDO_CLOUD_URL. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** The wire carries the v3 call options verbatim minus the per-call plumbing
 * that cannot cross a process boundary: the abort signal (threaded into fetch
 * instead) and per-call provider headers (the console owns its provider). */
function wireOptions(callOptions: unknown): { options: Record<string, unknown>; signal: AbortSignal | undefined } {
  const { abortSignal, headers, ...options } = (callOptions ?? {}) as Record<string, unknown> & {
    abortSignal?: AbortSignal;
    headers?: unknown;
  };
  void headers;
  return { options, signal: abortSignal };
}

async function errorFrom(response: Response): Promise<VendoError> {
  let payload: unknown = {};
  try {
    payload = await response.json();
  } catch {
    // Non-JSON bodies fall through to the default message below.
  }
  const error = (payload as { error?: { message?: unknown } }).error;
  const message = typeof error?.message === "string"
    ? error.message
    : `Vendo Cloud inference request failed with ${response.status}`;
  return new VendoError(response.status === 402 ? "cloud-required" : "validation", message);
}

/** Split an NDJSON byte stream into parsed parts, forwarding each part the
 * moment its line is complete — never buffering past a line boundary, so
 * generation latency is exactly the console's latency. */
function ndjsonParts(body: ReadableStream<Uint8Array>): ReadableStream<unknown> {
  const decoder = new TextDecoder();
  let buffered = "";
  const reader = body.getReader();
  return new ReadableStream<unknown>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          const tail = buffered.trim();
          if (tail.length > 0) controller.enqueue(JSON.parse(tail) as unknown);
          controller.close();
          return;
        }
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        if (newline === -1) continue;
        while (newline !== -1) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line.length > 0) controller.enqueue(JSON.parse(line) as unknown);
          newline = buffered.indexOf("\n");
        }
        return;
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/** The Cloud adapter — managed inference: the same LanguageModel surface,
 * served by the Vendo Cloud console (which holds the provider credentials and
 * meters usage as managed-LLM passthrough). Wire (the console implements it):
 *   POST {base}/api/v1/inference   auth: Bearer VENDO_API_KEY
 *   request  { mode: "generate" | "stream", options: <v3 call options> }
 *   generate → the v3 doGenerate result as JSON
 *   stream   → NDJSON: one v3 stream part per line, relayed unbuffered
 *   402      → meter exhausted; surfaces as a clear cloud-required error. */
export function cloudModel(options: CloudModelOptions): LanguageModel {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function call(mode: "generate" | "stream", callOptions: unknown): Promise<Response> {
    const { options: wire, signal } = wireOptions(callOptions);
    const response = await fetchImpl(`${base}/api/v1/inference`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: mode === "generate" ? "application/json" : "application/x-ndjson",
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode, options: wire }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw await errorFrom(response);
    return response;
  }

  const model: LanguageModelV3Like = {
    specificationVersion: "v3",
    provider: "vendo-cloud",
    modelId: "managed",
    supportedUrls: {},
    async doGenerate(callOptions) {
      return await (await call("generate", callOptions)).json() as unknown;
    },
    async doStream(callOptions) {
      const response = await call("stream", callOptions);
      if (response.body === null) {
        throw new VendoError("validation", "Vendo Cloud inference returned no stream body");
      }
      return { stream: ndjsonParts(response.body) };
    },
  };
  return model as unknown as LanguageModel;
}

/** The no-model fallback adapter: every call fails closed with the exact
 * setup instructions (mirrors unconfiguredConnections). */
export function unconfiguredModel(): LanguageModel {
  const refuse = (): never => {
    throw new VendoError(
      "not-implemented",
      "no model configured: pass createVendo({ model }) — e.g. devModel() or your own ai-SDK model — or set VENDO_API_KEY for Vendo Cloud managed inference",
    );
  };
  const model: LanguageModelV3Like = {
    specificationVersion: "v3",
    provider: "vendo-unconfigured",
    modelId: "none",
    supportedUrls: {},
    doGenerate: async () => refuse(),
    doStream: async () => refuse(),
  };
  return model as unknown as LanguageModel;
}
