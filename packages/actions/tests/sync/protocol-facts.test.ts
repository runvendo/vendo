import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composioToolRisk } from "../../src/connectors/composio-risk.js";
import { walk } from "../../src/sync/common.js";
import { extractedRisk, trpcRisk } from "../../src/sync/common.js";

/**
 * Risk-grading redesign D1/D2 — the two halves of "no name guessing":
 * the word lists are gone and cannot come back, and what is left grades only
 * from facts that are true by definition of the protocol.
 */

const PACKAGES_DIR = fileURLToPath(new URL("../../../", import.meta.url));
/** The exact identifiers the spec's AC1 grep names, plus the helper that made
 *  a word list usable. Written split so this file does not match itself. */
const BANNED = [
  "DESTRUCTIVE" + "_WORDS", "READ" + "_WORDS", "DESTRUCTIVE" + "_TOKENS",
  "READ" + "_VERBS", "DESTRUCTIVE" + "_VERBS",
];

/**
 * NO verb vocabulary lives anywhere any more. The core decision-time vote
 * (`mechanicalRisk` / `resolvedRisk`, grant-sets.ts) that once held the last
 * word list was removed with two-vote grading (agents-v0, 2026-08-04): the
 * dev's label is final, so D1 now holds repo-wide with no exception —
 * nothing anywhere concludes anything from a tool's name.
 */
const KNOWN_DECISION_TIME_VOTE: string[] = [];

describe("no code path grades a tool from its NAME (D1, AC1)", () => {
  it("carries no word list anywhere under packages/, bar the one named exception", async () => {
    const sources = await walk(PACKAGES_DIR, (relative) =>
      /\.(?:ts|tsx|mts|cts)$/.test(relative) && !relative.includes("/dist/"));
    // Guards the grep itself: an empty sweep would pass vacuously forever.
    expect(sources.length).toBeGreaterThan(200);
    const offenders: string[] = [];
    for (const file of sources) {
      const source = await readFile(file, "utf8");
      if (!BANNED.some((token) => source.includes(token))) continue;
      const relative = file.slice(file.indexOf("packages/"));
      if (KNOWN_DECISION_TIME_VOTE.includes(relative)) continue;
      offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  }, 60_000);

  it("keeps every word list OUT of extraction and the connectors, which is what D1 governs", async () => {
    const graders = await walk(fileURLToPath(new URL("../../src/", import.meta.url)), (relative) =>
      /\.(?:ts|tsx)$/.test(relative) && !relative.includes("/dist/"));
    expect(graders.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of graders) {
      const source = await readFile(file, "utf8");
      if (BANNED.some((token) => source.includes(token))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  }, 60_000);
});

describe("extraction grades from PROTOCOL FACTS only (D2)", () => {
  it("grades DELETE destructive — the one HTTP method that is a fact", () => {
    expect(extractedRisk("DELETE")).toBe("destructive");
  });

  it("leaves a GET ungraded: GETs that mutate exist, so GET alone proves nothing (AC4)", () => {
    expect(extractedRisk("GET")).toBe("ungraded");
  });

  it("leaves POST/PUT/PATCH ungraded too — search endpoints post", () => {
    for (const method of ["POST", "PUT", "PATCH"] as const) {
      expect(extractedRisk(method)).toBe("ungraded");
    }
  });

  it("grades a DECLARED tRPC mutation at least write, and never grades a query read", () => {
    expect(trpcRisk("mutation")).toBe("write");
    expect(trpcRisk("query")).toBe("ungraded");
  });

  it("takes Composio's own hints and nothing else from a connector tool", () => {
    expect(composioToolRisk(["destructiveHint"])).toBe("destructive");
    expect(composioToolRisk(["readOnlyHint"])).toBe("read");
    expect(composioToolRisk()).toBe("ungraded");
  });
});
