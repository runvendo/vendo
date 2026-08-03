/**
 * The review FAILURE protocol — architecture design §7, evaluation E4.
 *
 * §7 promises: "FAIL → the commit lands as a flagged version (the previous
 * version keeps serving), one bounded fix round, then a plain-language card on the
 * app ('Your change didn't pass a safety check: <reason>. Fix it / keep the
 * current version'). An `owner` may accept a flagged version, with the override
 * recorded in the audit trail — except host-check failures, which only the host
 * can waive via its own policy config."
 *
 * NONE OF THAT EXISTS. Every test below is `.skip`, deliberately: the lane that
 * wrote this file was asked to find out whether the protocol was real, and a
 * false claim reported as false is the deliverable — not a subsystem built to
 * make the sentence true. Each test names exactly what must be built first.
 *
 * WHAT THE CODE DOES TODAY, with the evidence:
 *
 *  1. A blocking finding DOES now stop the write (2026-08-01, `./commit-gate.test.ts`).
 *     `runtime.ts` refuses at the commit path on both paths: `create()` fails the
 *     build before it emits or persists, and `edit()` returns `failedEdit(...)`
 *     before `persistEdit(...)` ever runs, so the previous app stays in its row
 *     and keeps serving. That is the FAIL half of §7 — but it is a REFUSAL, not
 *     the flagged-version protocol the rest of this file describes: what §7 asks
 *     for beyond it (a landed-but-flagged commit, a post-land fix round, a card
 *     with two choices, an owner override) is still absent, and the tests below
 *     still name it.
 *  2. There is no version status to be flagged. `AppDocument`
 *     (`packages/core/src/app-document.ts`) has no `status`/`flagged`/`review`
 *     field — the only failure-ish field is `buildFailed`, a terminal generation
 *     crash marker. `appRecordInput` (`../persistence.ts`) keys the row by the app
 *     id, so every write clobbers the live row. `createAppHistory`
 *     (`../history.ts`) archives the PREVIOUS doc for `undo()`, but serving always
 *     reads the single live row: there is no served-version pointer distinct from
 *     the latest-written one, so "the previous version keeps serving" has no
 *     mechanism.
 *  3. The bounded fix round exists but at the wrong time. `FIX_ROUNDS = 2` in
 *     `../generation/conductor.ts` re-invokes the brain on blocking findings — a
 *     PRE-land loop inside generation, two rounds rather than one, and whatever
 *     survives it lands unflagged.
 *  4. `Finding` (`packages/core/src/pack.ts`) is `{ severity, where?, message }`
 *     with no source or origin, and host judgment rules are folded into the
 *     reviewer's single rubric (`./reviewer.ts`). So a host-check failure is
 *     INDISTINGUISHABLE from a reviewer finding at any would-be waive point:
 *     §7's carve-out is not merely unimplemented, it is currently unrepresentable.
 *
 * The floor itself is real and good — the reviewer, the pack checks, the judgment
 * rubric and the fix rounds all work, and a `block` now stops the write. It is
 * the protocol AFTER a FAIL — the flagged version, its remediation round, its
 * card and its override — that is absent.
 */
import { describe, expect, it } from "vitest";

describe.skip("review failure protocol (design §7) — NOT IMPLEMENTED", () => {
  it("lands a FAILED commit as a flagged version while the previous keeps serving", () => {
    // MUST BE BUILT: (a) a version status on the stored app so a landed commit can
    // be `flagged`, and (b) a served-version pointer distinct from the
    // latest-written one, so `runtime.open` serves the previous doc while the
    // flagged one waits. Today a failing commit does not land at all — it is
    // refused, which keeps the previous version serving without either mechanism,
    // and leaves the failed work nowhere to sit.
    expect.fail("no version status and no served-version pointer exist");
  });

  it("gives a flagged version exactly one bounded fix round AFTER it lands", () => {
    // MUST BE BUILT: a post-land remediation round. `FIX_ROUNDS = 2` in
    // `../generation/conductor.ts` is a pre-land generation repair loop — a
    // different thing, at a different time, with a different bound.
    expect.fail("the only fix loop is pre-land generation repair");
  });

  it("raises a plain-language card on the app naming the reason and the two choices", () => {
    // MUST BE BUILT: a stream part for a failed safety check carrying the
    // finding's teaching sentence plus "Fix it" / "keep the current version". The
    // nearest shipped thing is `data-vendo-build-failed`, a terminal build crash
    // banner with no choice attached.
    expect.fail("no review-failure part exists in the stream vocabulary");
  });

  it("lets an `owner` accept a flagged version, recording the override in the audit trail", () => {
    // MUST BE BUILT: an accept-flagged path, plus an app-lifecycle audit event for
    // the override (`appLifecycleEvent` in `../audit.ts` is the mint; nothing
    // emits an override today). Note also that no `owner` ROLE exists — ownership
    // is a `ctx.principal.subject` string compare in `requireOwned`.
    expect.fail("no accept-flagged path and no owner role exist");
  });

  it("refuses an owner override of a HOST-check failure", () => {
    // MUST BE BUILT FIRST: provenance on `Finding`. Until a finding says which
    // check produced it, "except host-check failures" cannot be evaluated at all —
    // host judgment rules currently come back as ordinary reviewer findings, and
    // fact-check findings flatten into one anonymous `Finding[]` in `./layer.ts`.
    expect.fail("Finding carries no check provenance, so a host-check failure cannot be identified");
  });
});
