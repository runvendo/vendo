/** The batched, bounded, retrying Cloud upload loop — one copy, two streams.
 *
 * Extracted VERBATIM from the capability-miss uploader (`capability-misses.ts`)
 * when the SDK-events stream needed the same loop: same batch size, same queue
 * cap, same per-request timeout, same two retry delays, same "drop only the
 * Cloud copy" ending. The miss suite is the proof it still behaves the same.
 *
 * What each stream keeps for itself is the `path` it POSTs to, the `body` it
 * builds from a batch, and what counts as an accepted answer. Keep this module
 * free of node builtins — the portability gate bundles it.
 */
import { cloudKeyFetch } from "./cloud-key-fetch.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_QUEUE_LIMIT = 1_000;
const DEFAULT_BATCH_DELAY_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_500;
const DEFAULT_RETRY_DELAYS_MS = [250, 1_000] as const;

export interface BatchedUploader<T> {
  enqueue(event: T): void;
  /** Drain hook for tests and orderly host shutdown; a turn never awaits it. */
  flush(): Promise<void>;
}

export interface BatchedUploaderOptions<T> {
  /** The console API path this stream POSTs to. */
  path: string;
  /** ADAPTER RULE: the key and base URL arrive from the composition seam. The
   *  uploader never reads the environment for either. */
  cloud: { apiKey: string; baseUrl?: string };
  /** The request body for one batch. Resolved INSIDE the retry loop, so a
   *  failure to build it costs a retry rather than the whole batch. */
  body: (events: T[]) => Promise<unknown> | unknown;
  /** Is this a real answer? A `false` retries the batch like a transport
   *  failure — a 200 carrying something we cannot read is not a delivery. */
  accept: (response: unknown) => boolean;
  /** The console telling this deployment to stop talking. Checked BEFORE
   *  `accept`, and it ends the stream for the rest of the process lifetime:
   *  the queue is dropped and nothing is ever sent again. */
  stop?: (response: unknown) => boolean;
  fetchImpl?: typeof fetch;
  batchSize?: number;
  queueLimit?: number;
  batchDelayMs?: number;
  requestTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    unrefTimer(timer);
  });
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
}

export function createBatchedUploader<T>(options: BatchedUploaderOptions<T>): BatchedUploader<T> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
  const batchDelayMs = options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const queue: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let stopped = false;

  const send = async (events: T[]): Promise<void> => {
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      unrefTimer(timeout);
      try {
        const response = await cloudKeyFetch<unknown>(options.path, {
          apiKey: options.cloud.apiKey,
          // The seam already resolved VENDO_CLOUD_URL into baseUrl; an empty
          // env pins resolution to it (or the console default) so no hidden
          // process-env read survives here (adapter rule).
          ...(options.cloud.baseUrl === undefined ? {} : { apiUrl: options.cloud.baseUrl }),
          env: {},
          fetchImpl: options.fetchImpl,
          signal: controller.signal,
          body: await options.body(events),
        });
        if (options.stop?.(response) === true) {
          stopped = true;
          queue.length = 0;
          return;
        }
        if (!options.accept(response)) throw new Error(`Invalid Vendo Cloud ${options.path} response`);
        return;
      } catch {
        const retryDelay = retryDelaysMs[attempt];
        if (retryDelay === undefined) return;
        await delay(retryDelay);
      } finally {
        clearTimeout(timeout);
      }
    }
  };

  const drain = async (): Promise<void> => {
    while (queue.length > 0 && !stopped) {
      const batch = queue.splice(0, batchSize);
      await send(batch);
    }
  };

  const flush = async (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (active) {
      await active;
      if (queue.length === 0) return;
    }
    active = drain().finally(() => {
      active = undefined;
    });
    await active;
  };

  const schedule = (): void => {
    if (timer !== undefined || active !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush().catch(() => undefined);
    }, batchDelayMs);
    unrefTimer(timer);
  };

  return {
    enqueue(event) {
      if (stopped || queue.length >= queueLimit) return;
      queue.push(event);
      if (queue.length >= batchSize) void flush().catch(() => undefined);
      else schedule();
    },
    flush,
  };
}
