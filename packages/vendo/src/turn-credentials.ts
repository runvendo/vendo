/**
 * The turn-credential REGISTRY — composition's half of the door's second door.
 *
 * It lives in the umbrella because it is the one place that owns both ends: the
 * harness runtime publishes each live turn here, and `createMcpDoor` reads from
 * here. Neither block can see the other (layering: `@vendoai/mcp` → core only),
 * and neither needs to.
 *
 * **The credential in five sentences.** The host process mints an opaque token
 * for one conversation, and only ever from INSIDE a live turn of that
 * conversation, which is what binds it to a subject nobody had to name. The
 * token states nothing — no subject, no scope, no venue — so there is nothing in
 * it to forge; it is a pointer at "the turn currently in flight on thread T".
 * Its authority window is that turn: between turns it resolves to nothing, and a
 * call arriving then is a 401, because a call with no turn behind it has no
 * accountability context to be judged in. It dies on `revoke()` (the machine
 * holding it was destroyed), on an idle sweep, and permanently if its thread is
 * ever seen carrying a different principal. Everything it can reach is what that
 * turn could already reach — `turn.tools`, which is the guard-bound registry
 * with the turn's own ctx.
 */
import type { LiveTurn, TurnCredentialPort } from "@vendoai/mcp";

export type { LiveTurn } from "@vendoai/mcp";

/**
 * How long a credential survives without its conversation taking another turn.
 * This is GARBAGE COLLECTION, not the authority bound — authority is the live
 * turn, and there is no window in which this value grants anything. It matches
 * the door's own session idle budget so the two age out together.
 */
const CREDENTIAL_IDLE_MS = 60 * 60 * 1000;

interface Minted {
  threadId: string;
  /** Read off the turn in flight at mint time — never supplied by a caller. */
  subject: string;
  expiresAt: number;
}

export interface TurnCredentials extends TurnCredentialPort {
  /**
   * Publish the turn now in flight on `threadId`. Called by the harness runtime
   * for EVERY turn, and the returned disposer at turn end. Publishing is not a
   * grant: it is what makes an already-minted credential resolvable again.
   */
  publish(threadId: string, turn: LiveTurn): () => void;
  /**
   * Mint a credential for `threadId`, or `undefined` when no turn of that thread
   * is in flight. Deliberately un-mintable from outside a turn: the subject is
   * READ from the live turn, so there is no parameter through which a caller
   * could name one.
   */
  mint(threadId: string): string | undefined;
  revoke(token: string): void;
}

export interface TurnCredentialsOptions {
  /** Test seam. */
  now?: () => number;
  /** Test seam; production uses {@link CREDENTIAL_IDLE_MS}. */
  idleMs?: number;
}

export function createTurnCredentials(options: TurnCredentialsOptions = {}): TurnCredentials {
  const now = options.now ?? (() => Date.now());
  const idleMs = options.idleMs ?? CREDENTIAL_IDLE_MS;
  /** thread → the turn in flight. At most one; a conversation is serialized. */
  const live = new Map<string, LiveTurn>();
  const minted = new Map<string, Minted>();

  /** 128 bits from the platform CSPRNG. Nothing about the thread is derivable
   *  from it, so holding one token tells you nothing about any other. */
  const mintToken = (): string =>
    `vtk_${[...globalThis.crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

  /** A thread seen carrying a different principal burns every credential minted
   *  for it — permanently, not until the rightful subject returns. Reaching here
   *  at all means something above us (the thread repository refuses a foreign
   *  thread) already failed, so the honest move is to stop trusting the id. */
  const burn = (threadId: string): void => {
    for (const [token, entry] of minted) {
      if (entry.threadId === threadId) minted.delete(token);
    }
  };

  return {
    publish(threadId, turn) {
      const subject = turn.ctx.principal.subject;
      // Compared against what was MINTED, never against the previously live
      // turn: between turns nothing is live, so a foreign turn that came and
      // went with no call arriving would leave nothing to compare against and
      // the credential would come back to life on the rightful subject's next
      // turn — a token that survived its thread changing hands.
      const foreign = [...minted.values()]
        .some((entry) => entry.threadId === threadId && entry.subject !== subject);
      if (foreign) burn(threadId);
      live.set(threadId, turn);
      // Touch every credential of this conversation: a thread still taking turns
      // is a thread still in use, and the idle budget is about abandonment.
      // Every survivor matches `subject` — the burn above saw to that.
      for (const entry of minted.values()) {
        if (entry.threadId === threadId) entry.expiresAt = now() + idleMs;
      }
      return () => {
        // Only ever retract OUR publication. A disposer that ran after the next
        // turn had already opened would otherwise unpublish the live one.
        if (live.get(threadId) === turn) live.delete(threadId);
      };
    },

    mint(threadId) {
      const turn = live.get(threadId);
      if (turn === undefined) return undefined;
      const token = mintToken();
      minted.set(token, {
        threadId,
        subject: turn.ctx.principal.subject,
        expiresAt: now() + idleMs,
      });
      return token;
    },

    revoke(token) {
      minted.delete(token);
    },

    async resolve(token) {
      const entry = minted.get(token);
      if (entry === undefined) return null;
      if (entry.expiresAt <= now()) {
        minted.delete(token);
        return null;
      }
      const turn = live.get(entry.threadId);
      // No turn in flight: a call with nothing to attribute it to. This is the
      // 401 the design wants, not a fallback to some ambient context.
      if (turn === undefined) return null;
      if (turn.ctx.principal.subject !== entry.subject) {
        burn(entry.threadId);
        return null;
      }
      return turn;
    },
  };
}
