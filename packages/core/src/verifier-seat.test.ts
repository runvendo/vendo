import { describe, expect, it } from "vitest";
import { migrateModelSeats, SEATS } from "./index.js";

/** Finding 2 — folding knowledgeVerifier into `default` silently repointed the
 *  AGENT model whenever a host set only that knob. The fold's premise (no
 *  independent consumer) was false; the contract amendment gives it a seat. */
describe("the verifier seat (contract amendment 2026-07-30)", () => {
  it("is one of the five contracted seats", () => {
    expect(SEATS).toEqual(["default", "reviewer", "judge", "fill", "verifier"]);
  });

  it("maps knowledgeVerifier to `verifier`, NOT to `default`", () => {
    expect(migrateModelSeats({ knowledgeVerifier: "haiku" })).toEqual({ verifier: "haiku" });
  });

  it("leaves the agent model untouched when only knowledgeVerifier is set", () => {
    // The regression in one line: setting the knowledge check's cheap/fast model
    // must never change which model answers users.
    const seats = migrateModelSeats({ knowledgeVerifier: "haiku" });
    expect(seats.default).toBeUndefined();
  });

  it("keeps the two independent when both are set", () => {
    expect(migrateModelSeats({ agent: "opus", knowledgeVerifier: "haiku" }))
      .toEqual({ default: "opus", verifier: "haiku" });
  });

  it("carries an explicit `verifier` seat straight through", () => {
    expect(migrateModelSeats({ verifier: "sonnet" })).toEqual({ verifier: "sonnet" });
  });

  it("prefers the new seat name when both spellings are present", () => {
    expect(migrateModelSeats({ verifier: "new", knowledgeVerifier: "old" })).toEqual({ verifier: "new" });
  });
});
