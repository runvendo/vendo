/** ENG-353 — server-side turn liveness: the idle-abort fallback for client
 * disconnects the runtime never surfaces.
 *
 * The fast path is unchanged: `request.signal` cancels the turn the moment the
 * runtime propagates a fetch abort (wave-5 AGENT-3). But under `next dev` a
 * real browser's graceful tab-close/navigate-away fires neither the signal nor
 * a stream cancel, so an abandoned turn runs to completion. The fallback is
 * liveness by heartbeat: the panel beats `POST /threads/:id/heartbeat` while
 * it consumes the stream (08 — `withTurnHeartbeat`); the FIRST beat arms the
 * watchdog, and from then on `IDLE_ABORT_MS` of silence aborts the turn.
 * Arming is opt-in by construction: consumers that never beat (curl drills,
 * scripted clients, older panels) keep run-to-completion semantics.
 *
 * The registry lives on globalThis (Symbol.for) so HMR copies of this module
 * under a dev server share one view: a turn registered before an edit is still
 * beatable after it.
 */

const IDLE_ABORT_MS = 15_000;

interface ActiveTurn {
  threadId: string;
  subject: string;
  abort: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const ACTIVE_TURNS_KEY = Symbol.for("vendoai.vendo.active-turns@1");

function activeTurns(): Set<ActiveTurn> {
  const holder = globalThis as { [ACTIVE_TURNS_KEY]?: Set<ActiveTurn> };
  return (holder[ACTIVE_TURNS_KEY] ??= new Set());
}

/** Test seam only: the idle window, overridable per call site via env. */
function idleAbortMs(): number {
  const configured = Number(process.env.VENDO_TURN_IDLE_ABORT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : IDLE_ABORT_MS;
}

/** Track one streaming turn; returns its unregister. Registration alone never
 *  arms the watchdog — only a first heartbeat does. */
export function registerActiveTurn(turn: { threadId: string; subject: string; abort: () => void }): () => void {
  const entry: ActiveTurn = { ...turn };
  activeTurns().add(entry);
  return () => {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    activeTurns().delete(entry);
  };
}

/** A heartbeat for `threadId` from `subject`. Refreshes (and on first beat
 *  arms) the idle watchdog of every matching in-flight turn. Foreign or
 *  unknown ids answer false — no oracle, and a beat can never keep (or end)
 *  another principal's turn. */
export function touchActiveTurn(threadId: string, subject: string): boolean {
  let active = false;
  for (const turn of activeTurns()) {
    if (turn.threadId !== threadId || turn.subject !== subject) continue;
    active = true;
    if (turn.idleTimer !== undefined) clearTimeout(turn.idleTimer);
    turn.idleTimer = setTimeout(() => {
      console.warn(
        `[vendo] turn on thread ${turn.threadId} lost its client heartbeat for ${idleAbortMs()}ms — aborting the abandoned turn.`,
      );
      // Drop the entry now (idempotent with the stream-settled unregister):
      // an idle-aborted turn is over, and a late beat must see it inactive
      // even before the runtime drains the closing stream.
      activeTurns().delete(turn);
      turn.abort();
    }, idleAbortMs());
    turn.idleTimer.unref?.();
  }
  return active;
}

/** Wrap a turn response so `onSettled` runs exactly once when its stream
 *  finishes, errors, or is cancelled — the turn's registry entry must not
 *  outlive the stream. Mirrors the wire's inflight-bracket wrapper. */
export function trackTurnResponse(response: Response, onSettled: () => void): Response {
  if (response.body === null) {
    onSettled();
    return response;
  }
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    onSettled();
  };
  const reader = response.body.getReader();
  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          settle();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    cancel(reason) {
      settle();
      return reader.cancel(reason);
    },
  });
  return new Response(tracked, response);
}
