/**
 * The compaction state codec — what a thread remembers between turns.
 *
 * The slot is `turn.state` (build contract §1.3): ONE opaque string per thread,
 * written at turn end and handed back on the next turn. Opaque means the codec is
 * the only thing standing between a stored string and the loop's assumptions, and
 * the string can be older than this build: a slot written by a future version, or
 * by a different harness, or truncated by a store that lost half a row. Every one
 * of those reads as "no state" rather than as a shape the loop then trusts —
 * losing the state costs one un-compacted turn, and trusting a bad one costs a
 * prompt nobody can predict.
 */
import { describe, expect, it } from "vitest";
import { readCompactionState, writeCompactionState, type CompactionState } from "./compaction.js";

describe("the compaction state codec", () => {
  it("round-trips everything the slot carries", () => {
    const state: CompactionState = {
      version: 1,
      summary: "The user is reconciling January.",
      boundaryMessageId: "m_42",
    };
    expect(readCompactionState(writeCompactionState(state))).toEqual(state);
  });

  it("drops a MEASUREMENT an older build wrote, rather than carrying it", () => {
    // Every build before this one stored the provider's reported prompt count
    // (`lastPromptTokens`) and a `coveredThroughMessageId` that marked where the
    // thread stood rather than what the summary absorbed. Both drove the trigger
    // and both were wrong about it. A row that still holds them reads as the
    // summary alone — and with no boundary the projection discards even that and
    // measures the full transcript, which is one extra compaction in the safe
    // direction.
    const legacy = JSON.stringify({
      version: 1,
      summary: "The user is reconciling January.",
      coveredThroughMessageId: "m_42",
      lastPromptTokens: 91_284,
    });
    expect(readCompactionState(legacy)).toEqual({
      version: 1,
      summary: "The user is reconciling January.",
    });
  });

  it("discards an UNKNOWN version rather than guessing at its shape", () => {
    expect(readCompactionState(JSON.stringify({ version: 2, summary: "from the future" }))).toBeUndefined();
    expect(readCompactionState(JSON.stringify({ summary: "from before versions" }))).toBeUndefined();
  });

  it("discards an UNREADABLE string", () => {
    // A foreign harness's session id, a truncated row, a store that handed back
    // half a value: none of them is a compaction state, and none may throw.
    expect(readCompactionState("sess_01HZY3")).toBeUndefined();
    expect(readCompactionState("{\"version\":1")).toBeUndefined();
    expect(readCompactionState("[1,2,3]")).toBeUndefined();
    expect(readCompactionState("null")).toBeUndefined();
  });

  it("reads an EMPTY slot as no state", () => {
    expect(readCompactionState(undefined)).toBeUndefined();
    expect(readCompactionState("")).toBeUndefined();
  });

  it("drops fields of the wrong type instead of handing them on", () => {
    // A number where a string belongs is the same class of problem as an
    // unreadable slot, but only for that one field — the rest still works.
    const slot = JSON.stringify({ version: 1, summary: 7, boundaryMessageId: [] });
    expect(readCompactionState(slot)).toEqual({ version: 1 });
  });
});
