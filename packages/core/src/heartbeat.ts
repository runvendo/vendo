/** ENG-353 — panel-side turn heartbeat.
 *
 * Some server runtimes never surface a graceful client disconnect to a
 * streaming route handler (`next dev` is the field case: a closed tab fires
 * neither `request.signal` nor a stream cancel), so an abandoned turn runs to
 * completion and burns provider tokens. The wire's fallback is liveness by
 * heartbeat: while a turn streams, the consumer beats
 * `POST /threads/:id/heartbeat`; once a turn has been beaten at least once,
 * ~15s of silence idle-aborts it server-side. Consumers that never beat are
 * unaffected (scripted/curl clients keep their run-to-completion semantics),
 * and the fetch-abort fast path stays the immediate cancellation road.
 *
 * `withTurnHeartbeat` wraps a `POST /threads` streaming Response: it starts
 * beating the moment the response arrives (thread id from
 * `X-Vendo-Thread-Id`) and stops when the stream ends, errors, is cancelled,
 * or the wire answers `active: false`. Non-streaming, non-ok, or header-less
 * responses pass through untouched.
 */
import { defaultFetch } from "./fetch.js";

const THREAD_ID_HEADER = "x-vendo-thread-id";
const DEFAULT_BEAT_INTERVAL_MS = 5_000;

export interface TurnHeartbeatOptions {
  /** The wire mount the turn was posted to (e.g. `https://host/api/vendo`). */
  baseUrl: string;
  /** Extra headers for beat requests (the client's wire headers). */
  headers?: Record<string, string>;
  /** Beat cadence; the server's idle window is a small multiple of this. */
  intervalMs?: number;
  /** Injection seam for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export function withTurnHeartbeat(response: Response, options: TurnHeartbeatOptions): Response {
  const threadId = response.headers.get(THREAD_ID_HEADER);
  if (threadId === null || !response.ok || response.body === null) return response;

  const fetchImpl = options.fetch ?? defaultFetch;
  const url = `${options.baseUrl.replace(/\/$/, "")}/threads/${encodeURIComponent(threadId)}/heartbeat`;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
  };

  const beat = async (): Promise<void> => {
    try {
      const result = await fetchImpl(url, {
        method: "POST",
        headers: { ...options.headers, "content-type": "application/json" },
        body: "{}",
      });
      if (!result.ok) {
        stop(); // wire without the route (or auth lost) — don't spam
        return;
      }
      const payload = await result.json().catch(() => undefined) as { active?: boolean } | undefined;
      if (payload?.active === false) stop();
    } catch {
      // Transient network failure — keep beating; the server's idle window
      // tolerates a missed beat or two.
    }
  };

  void beat();
  timer = setInterval(() => {
    if (!stopped) void beat();
  }, options.intervalMs ?? DEFAULT_BEAT_INTERVAL_MS);
  // In Node consumers the beat timer must never hold the process open.
  (timer as { unref?: () => void }).unref?.();

  const reader = response.body.getReader();
  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          stop();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        stop();
        controller.error(error);
      }
    },
    cancel(reason) {
      stop();
      return reader.cancel(reason);
    },
  });
  return new Response(tracked, response);
}
