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

import { log } from "@vendoai/core";
import { environment } from "./wire/shared.js";

const IDLE_ABORT_MS = 15_000;

/** What the client is told when the watchdog ends its turn: the ai-SDK stream's
 *  own terminal chunks. A turn the SERVER ended has to ARRIVE as an ending —
 *  without one the bytes simply stop, `useChat` stays in `streaming`, and the
 *  panel polls a turn that is never coming back. */
const IDLE_ABORT_FRAME = new TextEncoder().encode(
  `data: ${JSON.stringify({ type: "error", errorText: "This turn was stopped because the page stopped responding." })}\n\n`
  + "data: [DONE]\n\n",
);

/** The idle race's winner when the watchdog fired rather than a chunk arriving. */
const IDLE = Symbol("idle-abort");

interface ActiveTurn {
  threadId: string;
  subject: string;
  /** THIS turn, not merely this thread. Two turns can be in flight on one thread
   *  for one principal — nothing serializes them, which is why a beat refreshes
   *  every match below — so the finish signal has to name one of them. Absent
   *  for a caller that cannot name its turn; such a registration keeps exactly
   *  the run-to-completion semantics it always had. */
  turnId?: string;
  abort: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** The model has spoken and only the turn's own closing work is left, so the
   *  watchdog has stood down ({@link finishActiveTurn}). */
  finished?: boolean;
}

const ACTIVE_TURNS_KEY = Symbol.for("vendoai.vendo.active-turns@1");

function activeTurns(): Set<ActiveTurn> {
  const holder = globalThis as { [ACTIVE_TURNS_KEY]?: Set<ActiveTurn> };
  return (holder[ACTIVE_TURNS_KEY] ??= new Set());
}

/** Test seam only: the idle window, overridable per call site via env. The
 *  process-guarded `environment` helper keeps every beat working on
 *  edge/Worker targets with no `process` global. */
function idleAbortMs(): number {
  const configured = Number(environment("VENDO_TURN_IDLE_ABORT_MS"));
  return Number.isFinite(configured) && configured > 0 ? configured : IDLE_ABORT_MS;
}

/** Track one streaming turn; returns its unregister. Registration alone never
 *  arms the watchdog — only a first heartbeat does. */
export function registerActiveTurn(turn: {
  threadId: string;
  subject: string;
  turnId?: string;
  abort: () => void;
}): () => void {
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
    // Still in flight — its closing work is running — but past the point where
    // a vanished client may end it. The beat is answered; nothing is re-armed.
    if (turn.finished === true) continue;
    turn.idleTimer = setTimeout(() => {
      // Through the log seam, not a bare console call: an idle abort is the one
      // way a turn ends with a 200 and no trace, so the host's own
      // observability has to be able to see it.
      log({
        code: "vendo.turn-idle-abort",
        level: "warn",
        message: `[vendo] turn on thread ${turn.threadId} lost its client heartbeat for ${idleAbortMs()}ms — aborting the abandoned turn.`,
      });
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

/**
 * The turn's thinker is done: from here it is only the turn's own closing work —
 * the workspace commit that collects and syncs back what the agent built, then
 * the transcript, the harness state and the audit row. The watchdog stands down
 * at exactly this line.
 *
 * It exists because those two phases have opposite answers to "the client
 * vanished". A client that leaves MID-STREAM is what the watchdog is for: nobody
 * is waiting for the tokens still being generated. A client that leaves after
 * the last token is not — the work is already done and paid for, and aborting it
 * loses what the turn just made. That is the shipped failure: an abort landed
 * during sync-back, the turn's app never reached the store, and the response was
 * still a 200.
 *
 * Published from INSIDE the turn (`liveTurn`'s disposer, `harness-turn.ts`) for
 * the same reason the steer sink is: the boundary is a moment in the runtime's
 * loop, and the wire cannot see it — the response body stays open through the
 * whole commit, so the bytes running out is far too late to mean this.
 *
 * Addressed by TURN and not by thread, unlike the beat: nothing serializes two
 * turns on one thread, and standing one turn's watchdog down must not stand its
 * sibling's down with it — that sibling is still streaming, and reaping it if
 * its client leaves is the whole point of the watchdog.
 *
 * The registration STAYS: the turn really is still in flight, and a beat should
 * keep saying so until its stream ends.
 */
export function finishActiveTurn(turnId: string): void {
  for (const turn of activeTurns()) {
    if (turn.turnId !== turnId) continue;
    if (turn.idleTimer !== undefined) clearTimeout(turn.idleTimer);
    turn.finished = true;
  }
}

/**
 * The mid-turn STEER sink of a turn in flight (§10.2).
 *
 * Its own registry rather than a field on {@link ActiveTurn} because the two are
 * published by different halves at different moments: the wire registers the
 * abort from OUTSIDE the turn, once `runTurn.stream` has returned, while the
 * runtime publishes this from INSIDE it (`liveTurn`). One entry with two
 * registrars would be a two-phase handshake for no gain.
 */
interface SteerableTurn {
  threadId: string;
  subject: string;
  steer: (text: string, messageId: string) => Promise<boolean>;
}

const STEERABLE_TURNS_KEY = Symbol.for("vendoai.vendo.steerable-turns@1");

function steerableTurns(): Set<SteerableTurn> {
  const holder = globalThis as { [STEERABLE_TURNS_KEY]?: Set<SteerableTurn> };
  return (holder[STEERABLE_TURNS_KEY] ??= new Set());
}

/** Publish this turn's steer sink; returns its retraction. */
export function registerTurnSteer(turn: SteerableTurn): () => void {
  const entry: SteerableTurn = { ...turn };
  steerableTurns().add(entry);
  return () => { steerableTurns().delete(entry); };
}

/**
 * Hand `text` to `subject`'s own turn in flight on `threadId`. Principal-scoped
 * exactly like {@link touchActiveTurn}: foreign or unknown ids answer `false` —
 * no oracle, and nobody can speak into another principal's build.
 *
 * `false` is a FACT and not a failure: it is also the answer when the turn simply
 * cannot take a message, and the caller's own queue is the fallback either way.
 */
export async function steerActiveTurn(
  threadId: string,
  subject: string,
  text: string,
  messageId: string,
): Promise<boolean> {
  for (const turn of steerableTurns()) {
    if (turn.threadId !== threadId || turn.subject !== subject) continue;
    return await turn.steer(text, messageId);
  }
  return false;
}

/** Wrap a turn response so `onSettled` runs exactly once when its stream
 *  finishes, errors, or is cancelled — the turn's registry entry must not
 *  outlive the stream. Mirrors the wire's inflight-bracket wrapper.
 *
 *  `idle` is the watchdog's own abort (the wire holds one per turn, separate
 *  from the client-disconnect fast path): when it fires, this client's stream
 *  ENDS — terminal chunks, then close — because a turn the server ended must
 *  read as an ending on the wire. Only this branch is ended; the recording
 *  branch underneath keeps following the real turn, so a client that rejoins
 *  through `GET /threads/:id/stream` still replays what actually happened. */
export function trackTurnResponse(response: Response, onSettled: () => void, idle: AbortSignal): Response {
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
  const aborted = new Promise<typeof IDLE>((resolve) => {
    idle.addEventListener("abort", () => resolve(IDLE), { once: true });
  });
  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await Promise.race([reader.read(), aborted]);
        if (next === IDLE) {
          controller.enqueue(IDLE_ABORT_FRAME);
          settle();
          controller.close();
          void reader.cancel();
          return;
        }
        const { done, value } = next;
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
