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
 * The seam the umbrella fills. Absent, the door has exactly its previous
 * behavior — there is no second credential space and nothing to resolve.
 */
export interface TurnCredentialPort {
  /** Resolve a presented bearer to the live turn it names, or null. Never
   *  throws: an unresolvable token is simply not a turn credential. */
  resolve(token: string): Promise<LiveTurn | null>;
}
