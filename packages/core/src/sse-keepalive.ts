/** The SERVER→CLIENT half of the wire's keepalive (blueprint §4.1 item 5, §4.2).
 *
 * Not to be confused with `heartbeat.ts`, which points the other way:
 * `withTurnHeartbeat` is the CLIENT beating `POST /threads/:id/heartbeat` so the
 * server can idle-abort an abandoned turn. This file is transport framing —
 * bytes the server puts on an SSE response so the connection stays visibly
 * alive while nothing interesting is happening.
 *
 * Two problems, one policy:
 *
 * 1. **Time to first byte.** A turn's first real chunk waits on a provider call.
 *    Until then the response head may be sitting in a proxy buffer and the
 *    client has nothing at all.
 * 2. **Long silent gaps.** A slow tool call streams nothing for its whole
 *    duration; proxies and browsers drop connections that go quiet.
 *
 * The policy: emit a comment frame NOW, then one per `intervalMs` of silence.
 * SSE comments are ignored by every spec-compliant parser (the `eventsource-parser`
 * the ai-SDK's `DefaultChatTransport` uses treats a leading `:` as a comment and
 * emits nothing), so a keepalive is invisible to the client's message sequence.
 * It is deliberately NOT a `HarnessEvent` and NOT a `data-vendo-*` part: a
 * keepalive is not something that happened, it is the wire saying it is still there.
 *
 * Two sinks, because the two SSE surfaces in this repo genuinely differ: the
 * production wire returns a web `Response` (`withSseKeepalive`), and the `vendo
 * try` dev server writes to a Node `ServerResponse` (`startSseKeepalive`).
 */

/** The frame itself. An SSE comment — no event, no data, ~14 bytes. */
export const SSE_KEEPALIVE_FRAME = ": heartbeat\n\n";

/** Well inside the 30–60s idle windows proxies and load balancers default to. */
export const DEFAULT_SSE_KEEPALIVE_INTERVAL_MS = 15_000;

export interface SseKeepaliveOptions {
  /** Cadence of silence-filling frames. Defaults to 15s. */
  intervalMs?: number;
}

/** Callback-sink form: writes a frame immediately, then one per interval, until
 *  the returned `stop` is called. For sinks that are not a web stream (Node's
 *  `ServerResponse`). */
export function startSseKeepalive(
  options: SseKeepaliveOptions & { write: (frame: string) => void },
): () => void {
  options.write(SSE_KEEPALIVE_FRAME);
  const timer = setInterval(
    () => options.write(SSE_KEEPALIVE_FRAME),
    options.intervalMs ?? DEFAULT_SSE_KEEPALIVE_INTERVAL_MS,
  );
  // A keepalive must never hold a Node process open.
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/** Stream-sink form: wrap an SSE `Response` so its first frame leaves at once
 *  and silence is punctuated.
 *
 *  Backpressure and ordering are preserved by construction: each pull races the
 *  in-flight source read against the keepalive deadline, and the read that loses
 *  is KEPT for the next pull — so a real chunk is never buffered, never delayed,
 *  and never dropped. No timer outlives the stream either: the deadline is a
 *  per-pull timeout, cleared on every path, and a closed or cancelled stream is
 *  never pulled again. */
export function withSseKeepalive(response: Response, options: SseKeepaliveOptions = {}): Response {
  if (response.body === null) return response;
  const intervalMs = options.intervalMs ?? DEFAULT_SSE_KEEPALIVE_INTERVAL_MS;
  const frame = new TextEncoder().encode(SSE_KEEPALIVE_FRAME);
  const reader = response.body.getReader();
  const KEEPALIVE = Symbol("sse-keepalive");
  /** The source read that lost a race, held for the next pull. */
  let inflight: ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> | undefined;
  let opened = false;

  const framed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!opened) {
        opened = true;
        controller.enqueue(frame);
        return;
      }
      const read = (inflight ??= reader.read());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<typeof KEEPALIVE>((resolve) => {
        timer = setTimeout(() => resolve(KEEPALIVE), intervalMs);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        const won = await Promise.race([read, deadline]);
        if (won === KEEPALIVE) {
          controller.enqueue(frame);
          return;
        }
        inflight = undefined;
        if (won.done) {
          controller.close();
          return;
        }
        controller.enqueue(won.value);
      } catch (error) {
        inflight = undefined;
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(framed, response);
}
