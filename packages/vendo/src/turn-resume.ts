/** The SERVER half of ai-SDK stream resume — blueprint §4.1 item 5, §4.2.
 *
 * The client half already ships in `ai@6`: `ChatTransport.reconnectToStream`
 * (what `useChat`'s `resumeStream()` calls) issues
 *
 *     GET {api}/{chatId}/stream
 *
 * and expects either `204` — nothing to resume, go back to ready — or an SSE
 * body it parses with the SAME reducer as the original turn. That request
 * carries NO cursor, so the only protocol the contract allows is
 * REPLAY-FROM-THE-START-OF-THE-TURN: the server cannot know what the client
 * missed, so it hands back everything the turn has emitted and then keeps
 * following it live. (This is also how the SDK's own resumable-stream design
 * works. We are matching it, not inventing.)
 *
 * Why a turn survives its reader vanishing: `recordResumableTurn` tees the turn
 * response — the same tee-plus-detached-drain seam the harness runtime already
 * uses to checkpoint parked turns (`harnesses/src/runtime.ts`). The recording
 * branch is drained by us, not by the client, so a client that stops reading
 * (recycled isolate, dropped socket, closed tab on `next dev`) does not stall
 * the turn. A client that genuinely ABORTS the fetch still kills the turn
 * through `request.signal` — the AGENT-3 fast path is untouched, and a resume
 * then replays as far as the turn actually got.
 *
 * State lifetime: per-turn, in memory, gone `RESUME_GRACE_MS` after the turn
 * settles. That is deliberately not a store table — there is nothing here worth
 * surviving a restart (a restart ends the turn), and the persisted transcript is
 * already the durable record. Frames are also capped: an in-memory buffer with
 * no ceiling is a memory footgun, and a turn past the cap simply becomes
 * unresumable (204) rather than unbounded.
 *
 * The registry lives on globalThis (Symbol.for) for the same reason
 * `turn-liveness.ts`'s does: HMR copies of this module under a dev server must
 * share one view of the in-flight turns.
 */

const RESUME_GRACE_MS = 30_000;
const MAX_RESUME_BYTES = 4 * 1024 * 1024;

interface ResumableTurn {
  threadId: string;
  subject: string;
  /** Raw SSE bytes, in wire order. Replayed verbatim — no re-serialization. */
  frames: Uint8Array[];
  bytes: number;
  settled: boolean;
  /** Past the byte cap: the buffer is dropped and the turn stops being resumable. */
  overflowed: boolean;
  /** Resolves whenever a frame lands or the turn settles. */
  changed: Promise<void>;
  wake: () => void;
}

const RESUMABLE_TURNS_KEY = Symbol.for("vendoai.vendo.resumable-turns@1");

function resumableTurns(): Set<ResumableTurn> {
  const holder = globalThis as { [RESUMABLE_TURNS_KEY]?: Set<ResumableTurn> };
  return (holder[RESUMABLE_TURNS_KEY] ??= new Set());
}

function armChanged(entry: ResumableTurn): void {
  entry.changed = new Promise<void>((resolve) => {
    entry.wake = resolve;
  });
}

function notify(entry: ResumableTurn): void {
  const wake = entry.wake;
  armChanged(entry);
  wake();
}

/** Wrap a streaming turn response so a dropped client can replay it. Returns the
 *  response to hand the client; the recording branch drains itself. */
export function recordResumableTurn(
  response: Response,
  key: { threadId: string; subject: string },
): Response {
  if (response.body === null) return response;
  // One resumable stream per thread: a new turn supersedes the last one's buffer.
  for (const existing of resumableTurns()) {
    if (existing.threadId === key.threadId && existing.subject === key.subject) {
      resumableTurns().delete(existing);
    }
  }
  const entry: ResumableTurn = {
    ...key,
    frames: [],
    bytes: 0,
    settled: false,
    overflowed: false,
    changed: Promise.resolve(),
    wake: () => undefined,
  };
  armChanged(entry);
  resumableTurns().add(entry);

  const [toClient, toRecord] = response.body.tee();
  void (async () => {
    const reader = toRecord.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (entry.overflowed) continue;
        entry.bytes += value.byteLength;
        if (entry.bytes > MAX_RESUME_BYTES) {
          entry.overflowed = true;
          entry.frames = [];
        } else {
          entry.frames.push(value);
        }
        notify(entry);
      }
    } catch {
      // A failed turn is still worth replaying up to the failure; the client's
      // own error part is already in the frames.
    } finally {
      entry.settled = true;
      notify(entry);
      // Followers already attached keep reading from `entry`; a reconnect after
      // the grace window gets 204 and falls back to the persisted transcript.
      const expiry = setTimeout(() => resumableTurns().delete(entry), RESUME_GRACE_MS);
      (expiry as { unref?: () => void }).unref?.();
    }
  })();

  return new Response(toClient, response);
}

/** The turn's stream from the beginning, or null when there is nothing to resume.
 *  Principal-scoped: a foreign or unknown thread id is indistinguishable from an
 *  idle one — no oracle, exactly like `touchActiveTurn`. */
export function resumableTurnStream(key: { threadId: string; subject: string }): ReadableStream<Uint8Array> | null {
  let entry: ResumableTurn | undefined;
  for (const candidate of resumableTurns()) {
    if (candidate.threadId === key.threadId && candidate.subject === key.subject) entry = candidate;
  }
  if (entry === undefined || entry.overflowed) return null;
  const turn = entry;
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (index >= turn.frames.length) {
        if (turn.settled) {
          controller.close();
          return;
        }
        await turn.changed;
      }
      controller.enqueue(turn.frames[index]!);
      index += 1;
    },
  });
}
