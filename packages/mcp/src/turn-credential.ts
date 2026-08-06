/**
 * 10-mcp §3b — the door's SECOND way in: a credential the host process mints
 * for its own harness, beside the OAuth grants an outside agent arrives with.
 *
 * **Why the door needed one.** The door was built for outside agents, so every
 * RunContext it minted said `venue: "mcp"`, `presence: "present"`, and every
 * approval it hit was answered in-band with "resolve it in the product and
 * retry". A `claudeCode()` box reaching its host's tools over native remote MCP
 * has a live turn behind it — a real venue, a real presence, a real stream to
 * put an approval card on — and losing all of that at the door made the door
 * unusable for it (measured: `packages/vendo/src/mcp-door-parity.e2e.test.ts`).
 *
 * **The shape, and why it cannot impersonate.** A token states NOTHING. It is an
 * opaque pointer at "the turn currently in flight on thread T", handed out by
 * the process that owns both the door and the harness. There is no subject in
 * it, no scope in it, no venue in it — so there is nothing to forge. Whatever
 * the pointed-at turn could already do is exactly what the credential can do,
 * and the moment no turn of that thread is in flight it resolves to nothing.
 *
 * The door therefore adds NO permission of its own on this path: it hands the
 * call to `turn.tools.call()`, which is the same guard, the same approval
 * machinery, the same audit row and the same transcript mirror the in-process
 * path uses. Parity is by construction, not by a second implementation.
 */
import type { RunContext, TurnTools } from "@vendoai/core";

/** One live turn, as the door needs to see it. */
export interface LiveTurn {
  /** THIS turn's own accountability context — its venue, its presence, its
   *  principal. The door projects it verbatim; it never relabels. */
  readonly ctx: RunContext;
  /** The turn's own tool surface. Guard, approval wait, audit row, transcript
   *  mirror and `workspace.commit()` all happen INSIDE it. */
  readonly tools: TurnTools;
}

/**
 * The seam composition fills. Absent, the door has exactly its previous
 * behavior — there is no second credential space and nothing to resolve.
 */
export interface TurnCredentialPort {
  /** Resolve a presented bearer to the live turn it names, or null. Never
   *  throws: an unresolvable token is simply not a turn credential. */
  resolve(token: string): Promise<LiveTurn | null>;
}

/**
 * The turn-credential REGISTRY — composition's half of the door's second door.
 *
 * It lives HERE, beside the types it speaks, because both ends attach to it and
 * neither owns it: a harness runtime publishes each live turn, and
 * `createMcpDoor` reads. The umbrella (`createVendo`) and the standalone agent
 * runtime (`agent()`) each compose one, and neither may reach the other's
 * package — this block is the lowest one both may depend on.
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
