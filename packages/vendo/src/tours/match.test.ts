import { describe, expect, it } from "vitest";
import { couldReachTour, matchTour, normalizePrompt } from "./match.js";

/**
 * The tour matcher's contract, in two halves that pull against each other.
 *
 * Tour prompts are typed live by a human in front of an audience, so the
 * MANGLED cases matter: an entry that only matches its frozen wording is an
 * entry one typo can kill. But an entry replays a RECORDING, so the cases that
 * matter just as much are the ones that must NOT match — a follow-up ask about
 * the app on screen has to reach the live agent and edit it, not replay it.
 *
 * The corpus is the Keystone demo's own, because that is where every one of
 * these was found: each `undefined` expectation below is a sentence that hit
 * the wrong beat under keyword matching, live, on a production host
 * (2026-07-31). Entry 0 builds a late-rent dashboard, entry 1 wires a Slack
 * alert, entry 2 regroups the rent roll, entry 3 pins whatever is on screen.
 */
const ENTRIES: readonly (readonly string[])[] = [
  [
    "Show me which units are behind on rent — build me a dashboard I can keep on my home page.",
    "Which units are behind on rent?",
  ],
  [
    "I don't want to keep checking this — when a rent payment goes late, just ping me on Slack.",
    "Ping me on Slack when rent goes late",
  ],
  [
    "This rent roll page — group it by building, biggest debtor on top, and show me a big red total.",
    "Group the rent roll by building",
  ],
  ["keep it", "pin it", "keep it on my home page"],
];

const match = (text: string, played?: readonly number[]): number | undefined =>
  matchTour({ text, entries: ENTRIES, ...(played === undefined ? {} : { played }) });

const FROZEN = {
  dashboard: ENTRIES[0]![0]!,
  slack: ENTRIES[1]![0]!,
  rentRoll: ENTRIES[2]![0]!,
  keepIt: ENTRIES[3]![0]!,
} as const;

/** The second phrasing of each entry — the suggestion chip a host renders as
 *  the zero-keystroke fallback for a fumbled line, so each one has to land its
 *  own entry exactly as the typed sentence does. */
const CHIPS = {
  dashboard: ENTRIES[0]![1]!,
  slack: ENTRIES[1]![1]!,
  rentRoll: ENTRIES[2]![1]!,
} as const;

describe("the frozen prompts", () => {
  it("matches entry 0 exactly as written", () => {
    expect(match(FROZEN.dashboard)).toBe(0);
  });

  it("matches entry 1 exactly as written — and NOT entry 0, whose keywords it contains", () => {
    expect(FROZEN.slack.toLowerCase()).toContain("late");
    expect(FROZEN.slack.toLowerCase()).toContain("rent");
    expect(match(FROZEN.slack)).toBe(1);
  });

  it("matches entry 2 exactly as written", () => {
    expect(match(FROZEN.rentRoll)).toBe(2);
  });

  it("matches the short entry — and NOT entry 0, whose sentence also says 'keep'", () => {
    expect(FROZEN.dashboard.toLowerCase()).toContain("keep");
    expect(match(FROZEN.keepIt)).toBe(3);
    expect(match(FROZEN.dashboard)).toBe(0);
  });

  it("matches every alternate phrasing", () => {
    expect(match(CHIPS.dashboard)).toBe(0);
    expect(match(CHIPS.slack)).toBe(1);
    expect(match(CHIPS.rentRoll)).toBe(2);
  });
});

/**
 * Entry 1's line contains entry 0's "late" and "rent", and entry 0's contains
 * entry 3's "keep". Under keyword matching that overlap was survived only by
 * testing the entries in a particular ORDER. Scoring retires the ordering: the
 * best-matching entry wins, so each frozen line lands its own entry however
 * they are declared.
 */
describe("overlapping wording still routes to the right entry", () => {
  it("entry 1 outscores entry 0 on entry 1's own line", () => {
    expect(match(FROZEN.slack)).toBe(1);
  });

  it("entry 2 outscores entry 0 on entry 2's own line, which also says 'rent' and 'show me'", () => {
    expect(normalizePrompt(FROZEN.rentRoll)).toContain("rent");
    expect(normalizePrompt(FROZEN.rentRoll)).toContain("show me");
    expect(match(FROZEN.rentRoll)).toBe(2);
  });

  it("the short entry does not steal entry 0, and entry 0 does not steal it", () => {
    expect(match(FROZEN.keepIt)).toBe(3);
    expect(match(FROZEN.dashboard)).toBe(0);
  });

  it("declaration order breaks a tie — the same phrasing on two entries lands the first", () => {
    const duplicated = [["show me the revenue chart"], ["show me the revenue chart"]];
    expect(matchTour({ text: "show me the revenue chart", entries: duplicated })).toBe(0);
  });
});

describe("tolerance — a typo on stage must not break the demo", () => {
  const cases: [string, number][] = [
    // em dash lost, capitals lost, trailing period lost
    ["show me which units are behind on rent - build me a dashboard i can keep on my home page", 0],
    // MISSPELL EACH REQUIRED WORD IN TURN. These are the cases keyword matching
    // got wrong: `includes` reads a corrupted keyword as an absent one, so every
    // one of these fell through to a live model call mid-demo.
    ["show me which units are behnid on rent - build me a dashboard i can keep on my home page", 0],
    ["Show me which units are behind on rnet — build me a dashboard I can keep on my home page.", 0],
    ["show me which units are behind on rent - build me a dashbord i can keep on my home page", 0],
    ["which units are behnid on rent", 0],
    // entry 1, with BOTH of its old keywords mangled at once — which used to be
    // the one mangling that replayed entry 0 instead of falling through
    ["I do not want to keep checking this - when a rent payment goes late just png me on Slcak", 1],
    // entry 2, both of its old keywords mangled
    ["this rent roll page - gruop it by buliding, biggest debtor on top, and show me a big red total", 2],
    // the short entry, said the other ways a person says it
    ["Keep it.", 3],
    ["pin it", 3],
    ["Keep it on my home page", 3],
  ];
  it.each(cases)("%j -> entry %i", (text, entry) => {
    expect(match(text)).toBe(entry);
  });

  /** Dropping a whole clause is the widest must-match the threshold allows;
   *  losing more than that is a different sentence and belongs to the agent. */
  it("survives a dropped opening clause", () => {
    expect(match("group it by building, biggest debtor on top, and show me a big red total.")).toBe(2);
  });
});

/**
 * THE REGRESSION THIS MATCHER EXISTS FOR.
 *
 * Every line here is about rent, or late rent, or the dashboard the audience is
 * looking at — and every one of them is a NEW ask that belongs to the live
 * agent. Keyword matching could not tell them from entry 0, so it replayed the
 * recording: the audience watched the same dashboard build twice, and the
 * replay threw away the pin that had just landed.
 */
describe("a follow-up about the app reaches the real agent, never the recording", () => {
  const followUps = [
    // the purple edit — found live on a production host, 2026-07-31
    "make the color you use to mark the late rent purple instead of red",
    "make the colour you use for late rent purple instead of red",
    // the tenants graph. A different chart of the same subject.
    "show me a graph of all the tenants I have with respect to how much rent they owe",
    "which tenants are behind on rent and by how much",
    // ordinary edits of whatever is on screen
    "add a column for the phone number",
    "make it bigger",
    "sort it by the amount owed",
    "drop the vacant units from that",
    // asks that reuse an entry's words for a different subject
    "group the maintenance tickets by building",
    "keep a running list of every maintenance ticket you have closed for me this quarter please",
    "keep it simple",
  ];
  it.each(followUps)("%j -> undefined", (text) => {
    expect(match(text)).toBeUndefined();
  });
});

describe("everything else falls through to the real agent", () => {
  const passthrough = [
    "",
    "   ",
    "hello",
    "which leases end in the next 90 days?",
    "build me a payment history table for Alder Court",
    "how many units do I have?",
  ];
  it.each(passthrough)("%j -> undefined", (text) => {
    expect(match(text)).toBeUndefined();
  });

  it("an empty tour matches nothing", () => {
    expect(matchTour({ text: FROZEN.dashboard, entries: [] })).toBeUndefined();
  });
});

/**
 * SHORT PROMPTS. A tour entry is often two or three words ("show me revenue"),
 * where token overlap alone is a poor signal — the character measure is what
 * carries these, and the two together still keep neighbouring asks apart.
 */
describe("short prompts", () => {
  const short = [["Show me revenue"], ["Show me costs"]];
  const shortMatch = (text: string): number | undefined => matchTour({ text, entries: short });

  it("lands on a one-character typo", () => {
    expect(shortMatch("show me revenu")).toBe(0);
    expect(shortMatch("Show me revenues")).toBe(0);
  });

  it("keeps two neighbouring short prompts apart", () => {
    expect(shortMatch("show me costs")).toBe(1);
    expect(shortMatch("show me revenue")).toBe(0);
  });

  it("does not swallow a narrower ask that merely starts the same way", () => {
    expect(shortMatch("show me revenue by region for the last two quarters")).toBeUndefined();
  });
});

/**
 * ONCE PER THREAD. The second rule, and the belt to the strict matcher's
 * braces: even a line that IS an entry's frozen wording falls through once that
 * entry has had its turn in the conversation. It is what guarantees a follow-up
 * is an edit of the app on screen rather than a second copy of it — including
 * the case the matcher cannot reason about, where the driver simply says the
 * same thing twice.
 */
describe("an entry is spent after it plays once in a thread", () => {
  it("falls through the second time entry 0 is asked for", () => {
    expect(match(FROZEN.dashboard, [])).toBe(0);
    expect(match(FROZEN.dashboard, [0])).toBeUndefined();
  });

  it("falls through on the alternate phrasing too, not just the typed line", () => {
    expect(match(CHIPS.dashboard, [0])).toBeUndefined();
  });

  it("applies to every entry", () => {
    expect(match(FROZEN.slack, [1])).toBeUndefined();
    expect(match(FROZEN.rentRoll, [2])).toBeUndefined();
    expect(match(FROZEN.keepIt, [3])).toBeUndefined();
  });

  /**
   * A demo is ONE conversation, so a spent entry must not spend the others:
   * entry 1 is typed into the same thread entry 0 played in, and entry 2 into
   * the same thread as both. Only the entry that played is gone.
   */
  it("leaves the entries that have not played alone", () => {
    expect(match(FROZEN.slack, [0, 3])).toBe(1);
    expect(match(FROZEN.rentRoll, [0, 3, 1])).toBe(2);
  });

  it("a spent entry does not push a line onto a DIFFERENT entry", () => {
    // Entry 0's line, with entry 0 spent, must not fall to entry 1 or entry 3
    // just because it contains "keep" and "rent".
    expect(match(FROZEN.dashboard, [0])).toBeUndefined();
  });
});

/**
 * The seam's cheap gate: deciding an entry for real means folding the whole
 * thread history back through the matcher, so a line that cannot match anything
 * must not pay for that. Every improvised ask takes this exit.
 */
describe("couldReachTour — the gate that keeps the live path fast", () => {
  it("is true for every frozen line and alternate phrasing", () => {
    for (const text of [...Object.values(FROZEN), ...Object.values(CHIPS)]) {
      expect(couldReachTour(text, ENTRIES), text).toBe(true);
    }
  });

  it("is false for the follow-ups and the improvisations", () => {
    for (const text of [
      "make the color you use to mark the late rent purple instead of red",
      "show me a graph of all the tenants I have with respect to how much rent they owe",
      "which leases end in the next 90 days?",
      "hello",
      "",
    ]) {
      expect(couldReachTour(text, ENTRIES), text).toBe(false);
    }
  });
});

describe("normalizePrompt", () => {
  it("strips punctuation, case, and collapses whitespace", () => {
    expect(normalizePrompt("  Rent — BEHIND?!  ")).toBe("rent behind");
  });
  it("is stable on an already-normal string", () => {
    expect(normalizePrompt("rent behind")).toBe("rent behind");
  });
});
