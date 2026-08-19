/**
 * The turns a person still owes an answer — findable and resumable from ANY
 * process, not just the one that parked them.
 *
 * `TurnResult.resume()` (turn.ts) is the same move for a caller still holding
 * the result. That closure dies with the process, and the ask does not: a
 * server restarts, the turn is on a queue worker and the yes arrives at a web
 * route, or the person answers tomorrow. So this face addresses a turn by ID.
 *
 * NOTHING NEW IS PERSISTED FOR IT. The guard's own approval row already carries
 * the exact `ToolCall` it parked and the ctx it was parked in
 * (`#parkApproval`, packages/guard/src/guard.ts) — including, now, the turn
 * that asked. That row IS the durable interrupted turn: `pending()` is the
 * list, and re-dispatching the stored call through the same guard-bound
 * registry is the resume. The guard's one-shot receipt on an approved call
 * (`#approvedReplay`) is what makes it exactly once, however many times a
 * flaky client asks.
 *
 * FAIL-CLOSED, in both directions. A turn nobody can see reads as absent, a
 * turn whose asks were already answered refuses rather than re-running them,
 * and an ask nobody answered in a week can no longer be answered at all.
 */
import {
  VendoError,
  type ApprovalId,
  type ApprovalRequest,
  type Decisions,
  type Interruption,
  type Principal,
  type ResumeOptions,
  type ThreadId,
  type TurnId,
} from "@vendoai/core";
import { toHeaderRecord } from "./session.js";
import { DEFAULT_MAX_TOOL_CALLS, expired, startTurn, type AgentDeps, type TurnResult } from "./turn.js";

/**
 * How long a parked turn waits for its person: seven days.
 *
 * The guard's own default is an hour, sized for a BYO agent loop with no
 * conversation to come back to. A turn's ask is answered by a HUMAN — who is
 * asleep, or off for the weekend — and an hour turns "approve this refund"
 * into work that silently has to be redone. Seven days is long enough for a
 * person and short enough that a week-old write is never approved into a world
 * that has moved on. A host's own `guard: { approvals: { parkedCallTtlMs } }`
 * still wins, and `createVendo` keeps the hour.
 */
export const PARKED_TURN_TTL_MS = 7 * 24 * 60 * 60_000;

/** One turn waiting on a person, as another process finds it. The same
 *  `turnId` the interrupted turn returned, the thread it is on, and the asks
 *  themselves — everything {@link Turns.resume} needs, and nothing a caller
 *  would have to join two reads to get. */
export interface InterruptedTurn {
  turnId: TurnId;
  threadId: ThreadId;
  interruptions: Interruption[];
}

/** The durable half of the turn contract. */
export interface Turns {
  /** Every turn of this user's that is waiting on them. `status` is named
   *  rather than assumed: a listing that quietly meant one thing is the kind
   *  that grows a second meaning later. */
  list(options: { status: "interrupted" }): Promise<InterruptedTurn[]>;
  /**
   * Answer a parked turn's interruptions and carry it on. The same
   * `TurnResult` any turn answers with — including `interrupted` again, if the
   * turn went on to ask for something else.
   *
   * The RESULT rather than a live `Turn`, because this call has to read the
   * store first (the thread and the parked calls are facts only the store has
   * once the process that asked is gone) and a `Turn` cannot survive that: a
   * `Turn` is itself a thenable, so `await turns.resume(…)` would unwrap the
   * handle to its result whatever this promise carried. The turn is watched
   * live where it is STARTED (`chat`/`run`); it is answered here.
   *
   * The answer is prose. An output schema belongs to the code that called
   * `run({ output })` and was never persisted, so a turn resumed from another
   * process reports in words — resume through the result you are holding
   * (`TurnResult.resume`) to keep the shape.
   */
  resume(turnId: string, decisions: Decisions, options?: ResumeOptions): Promise<TurnResult>;
}

/**
 * A parked ask THIS agent, on THIS lane, may answer.
 *
 * Every other lane that parks a call owns its own resume — an in-app action
 * resumes on the surface that asked (`packages/apps`), an automation's arming
 * yes mints the standing grant its consent moment was for (`packages/automations`)
 * — and re-dispatching one of those inside a fresh chat turn would answer it in
 * the wrong place. What is left is exactly a turn this package ran: it names
 * the turn that asked and the thread to carry on, and it belongs to no app and
 * no firing.
 *
 * And to exactly ONE agent. Every agent over a store shares its approvals
 * collection, so `agent` is checked first and checked strictly: an ask this
 * agent did not park — another agent's, or a row from before the field existed
 * — is skipped, not claimed. Anything looser answered `ops`' ask inside
 * `support`, which mounts a byte-identical `refund` descriptor and therefore a
 * matching `descriptorHash`, and spent the person's one yes on the wrong
 * implementation.
 */
const parkedByTurn = (request: ApprovalRequest, agent: string | undefined): boolean =>
  agent !== undefined
  && request.ctx.agent === agent
  && request.ctx.turnId !== undefined
  && request.ctx.sessionId !== undefined
  && request.ctx.appId === undefined
  && request.ctx.trigger === undefined;

const asInterruption = (request: ApprovalRequest): Interruption => ({
  id: request.id,
  type: "approval",
  toolCall: request.call,
});

/**
 * Nothing is parked under this id — which is two different answers.
 *
 * A decision the caller named that this subject really owns, on this turn,
 * already answered, PROVES the turn was interrupted and is not any more:
 * that is a conflict, and saying so is what tells a client its retry landed
 * the first time. Anything else — another user's turn, an id that never
 * existed, a turn that never parked — is the ownership law's absent: a thing
 * you do not own reads back as missing, never as forbidden.
 */
async function nothingWaiting(
  deps: AgentDeps,
  principal: Principal,
  turnId: string,
  decisions: Decisions,
): Promise<VendoError> {
  for (const id of Object.keys(decisions)) {
    const answered = await deps.guard.approvals.get?.(id as ApprovalId, principal);
    if (answered === undefined || answered.status === "pending") continue;
    // Scoped the way `parkedByTurn` scopes the feed: another agent's answered
    // ask is not this agent's conflict, it is a turn this agent never had.
    if (deps.agent === undefined || answered.request.ctx.agent !== deps.agent) continue;
    if (answered.request.ctx.turnId !== turnId) continue;
    return new VendoError(
      "conflict",
      `Turn ${turnId} is not interrupted any more — its approval ${id} was already ${answered.status}. `
      + "An ask is answered once, and this one has been. Ask again to get a fresh one.",
    );
  }
  return new VendoError(
    "not-found",
    `Turn ${turnId} has nothing waiting on an answer. `
    + "Call turns.list({ status: \"interrupted\" }) for the turns that do.",
  );
}

/** What one user can do with their own interrupted turns. Bound to a subject
 *  because every read under it is: the guard scopes a pending feed to its
 *  owner, so a turn another user parked is not visible here at all. */
export function createTurns(deps: AgentDeps, subject: string): Turns {
  const principal: Principal = { kind: "user", subject };
  const mine = async (turnId?: string): Promise<ApprovalRequest[]> =>
    (await deps.guard.approvals.pending(principal)).filter((request) =>
      parkedByTurn(request, deps.agent) && (turnId === undefined || request.ctx.turnId === turnId));

  return {
    // The guard's own pending feed, grouped — never a cache of it. So an ask
    // that was answered anywhere (a resume, a console tap, an abandonment
    // sweep) is gone from this list in the same instant it was answered, and
    // there is nothing here that could offer a turn nobody can act on.
    list: async () => {
      const at = Date.now();
      const ttlMs = deps.guard.approvals.parkedCallTtlMs;
      const turns = new Map<TurnId, InterruptedTurn>();
      for (const request of await mine()) {
        // Past the TTL is past acting on, whether or not a sweep has been by —
        // `resume` says so in words; a list of turns to act on just omits it.
        if (expired(request, ttlMs, at)) continue;
        const turnId = request.ctx.turnId as TurnId;
        const turn = turns.get(turnId) ?? {
          turnId,
          threadId: request.ctx.sessionId as ThreadId,
          interruptions: [],
        };
        turn.interruptions.push(asInterruption(request));
        turns.set(turnId, turn);
      }
      return [...turns.values()];
    },

    resume: async (turnId, decisions, options) => {
      const all = await mine(turnId);
      // The SAME deadline `list` applies, so both faces agree on what is
      // answerable. A turn holding one expired ask beside a live one used to be
      // offered as actionable and be answerable neither way: decide what the
      // list showed and it demanded an id nobody was shown, decide both and the
      // expired one refused the pair. Kept whole when EVERY ask is expired, so
      // that turn is still refused as expired rather than reported missing.
      const live = all.filter((request) => !expired(request, deps.guard.approvals.parkedCallTtlMs, Date.now()));
      const parked = live.length > 0 ? live : all;
      const first = parked[0];
      if (first === undefined) throw await nothingWaiting(deps, principal, turnId, decisions);

      // ALL of them or none. A half-answered turn would run the approved calls
      // and then carry on as if the rest had been considered, which is the one
      // outcome nobody asked for — and the ids are named because "some
      // decision is missing" is unanswerable from a client that holds five.
      const missing = parked.filter((request) => decisions[request.id] === undefined);
      if (missing.length > 0) {
        throw new VendoError(
          "validation",
          `Resuming turn ${turnId} needs a decision for every interruption it parked. Missing: `
          + `${missing.map((request) => request.id).join(", ")}. Pass "approve" or "deny" for each and resume again.`,
        );
      }

      const headers = toHeaderRecord(options?.headers);
      // Awaited by the async boundary: what this hands back is the turn's
      // result, and the turn runs to the end whether or not anyone waits (the
      // drainer-of-record property, turn.ts).
      return startTurn(deps, {
        // Unread: a resumed turn's ask is what the person ANSWERED, assembled
        // by `settleInterruptions` from the decisions above. This is the same
        // turn carrying on, not a new message.
        prompt: "",
        threadId: first.ctx.sessionId as ThreadId,
        // The SAME turn, across a park that outlived the process that made it.
        turnId: turnId as TurnId,
        reopen: true,
        ctx: {
          // Everything replayed here IDENTIFIES the parked call and none of it
          // authorizes anything: `sameParkedCall` pins the subject, the venue
          // and the presence, so a resume wearing another venue would miss the
          // very approval it is answering. AUTHORITY is the resuming call's
          // alone — the parked request's headers were request-lifetime and
          // that request is over, and its `context` is not replayed either, so
          // a tool that needs either one is handed what THIS caller brought.
          principal,
          venue: first.ctx.venue,
          presence: first.ctx.presence,
          sessionId: first.ctx.sessionId as string,
          ...(headers === undefined ? {} : { requestHeaders: headers }),
          ...(options?.context === undefined ? {} : { context: options.context }),
        },
        // The parked turn's own budget was the calling code's and is not on the
        // row; the resumed turn gets a fresh default one.
        maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
        resume: { guard: deps.guard, parked, decisions },
      });
    },
  };
}
