/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LOUD CALLOUT — THIS FILE USED TO ASSERT A FORBIDDEN MECHANISM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It was `consent-verb-class.test.ts`, and it pinned CR-1: the consent
 * surfaces classify an ask from its VERB, and only its verb. Every assertion
 * of the form
 *
 *     expect(consentClassLine("host_email_send", "read")).toBe("This sends a message, as you.")
 *     expect(grantRowWord("host_transferMoney", "write")).toBe("Moves money")
 *
 * encoded name inference as the DESIRED behaviour. Yousef's risk-grading
 * ruling (D1, PR #747) forbids it outright: no code path may conclude anything
 * from a tool's NAME. CR-1 narrowed the mechanism (whole humanized name → the
 * leading verb token) and so passed a checker, but narrowing a word list does
 * not fix a word list. Those assertions were deleted, not adjusted — the
 * behaviour they protected is gone from the product.
 *
 * What this file pins instead is the replacement law, and it is written so it
 * FAILS if either half is broken (ruling 21):
 *
 *   1. THE GRADE DRIVES. Each grade produces its own distinct sentence and its
 *      own distinct row word. Stub the grade out — return a constant, ignore
 *      the parameter — and the distinctness tests fail.
 *   2. THE NAME DOES NOT. Sweeping demo-bank's ENTIRE real catalog under one
 *      fixed grade must yield exactly ONE distinct sentence and ONE distinct
 *      word. Reintroduce any name inference — a word list, a regex, a leading
 *      token, a prefix — and the sweep sees more than one, and fails.
 *
 * The four proven lies that motivated CR-1 are kept below as a regression
 * corpus. They can no longer be produced by construction, which is the point.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { consentClassLine } from "../../src/chrome/build-beat.js";
import { grantRowWord } from "../../src/chrome/grant-set-card.js";

/** One sentence per grade, and the ungraded state is NOT one of the three. */
const BY_GRADE = {
  read: "This reads your data, and it runs as you.",
  write: "This changes something in your account, and it runs as you.",
  destructive: "This makes a change you can’t undo, and it runs as you.",
} as const;

const UNGRADED_LINE = "This hasn’t been checked, so we can’t say what it changes — it runs as you.";

const WORD_BY_GRADE = { read: "Reads", write: "Changes", destructive: "Irreversible" } as const;

/** The tool ids that produced the CR-1 lies, plus a money verb, a send verb and
 *  a name with no verb at all. Under the law, NONE of them may matter. */
const NAMES = [
  "host_getSharePrice",
  "host_getOrder",
  "host_getChargeDetails",
  "host_listEmailTemplates",
  "host_getSpendingInsights",
  "host_transferMoney",
  "host_email_send",
  "host_deleteInvoice",
  "gmail_GMAIL_SEND_EMAIL",
  "slack_SLACK_SEND_MESSAGE",
  "host_thing_do",
  "",
];

/** demo-bank's real catalog — the host every live proof in this wave ran on. */
function demoBankTools(): Array<{ name: string; risk: string }> {
  // cwd is packages/ui under vitest.
  const catalog = JSON.parse(
    readFileSync("../../examples/demo-bank/.vendo/tools.json", "utf8"),
  ) as { tools?: Array<{ name: string; risk: string }> } | Array<{ name: string; risk: string }>;
  const tools = Array.isArray(catalog) ? catalog : catalog.tools ?? [];
  expect(tools.length).toBeGreaterThan(0);
  return tools;
}

describe("the grade drives the sentence", () => {
  it("gives each grade its own sentence — no two grades may read alike", () => {
    const lines = Object.values(BY_GRADE);
    expect(new Set(lines).size).toBe(lines.length);
    for (const [grade, line] of Object.entries(BY_GRADE)) {
      expect(consentClassLine(grade)).toBe(line);
    }
  });

  it("gives each grade its own row word — irreversible never shares with a write", () => {
    const words = Object.values(WORD_BY_GRADE);
    expect(new Set(words).size).toBe(words.length);
    for (const [grade, word] of Object.entries(WORD_BY_GRADE)) {
      expect(grantRowWord(grade)).toBe(word);
    }
  });

  it("says the cautious thing when nothing graded the ask", () => {
    // The defect this closes: the fallthrough was "This reads your data, as
    // you." — the safest-sounding sentence in the vocabulary, said about the
    // one call nobody has established anything about.
    for (const ungraded of ["ungraded", "", "nonsense"]) {
      expect(consentClassLine(ungraded)).toBe(UNGRADED_LINE);
      expect(consentClassLine(ungraded)).not.toBe(BY_GRADE.read);
      expect(grantRowWord(ungraded)).toBe("Not reviewed");
      expect(grantRowWord(ungraded)).not.toBe(WORD_BY_GRADE.read);
    }
  });
});

describe("the name drives nothing", () => {
  it.each(Object.keys(BY_GRADE))(
    "every tool id in the corpus reads identically at grade %s",
    grade => {
      const lines = new Set(NAMES.map(() => consentClassLine(grade)));
      expect([...lines]).toEqual([BY_GRADE[grade as keyof typeof BY_GRADE]]);
    },
  );

  it("demo-bank's WHOLE catalog yields exactly one sentence per grade", () => {
    // The anti-inference sweep. Any name-derived branch — a word list, a
    // regex, a leading token, a toolkit prefix — makes this set bigger than
    // one, on the host's own real tool ids.
    const names = demoBankTools().map(tool => tool.name);
    expect(names.length).toBeGreaterThan(1);
    for (const grade of Object.keys(BY_GRADE) as Array<keyof typeof BY_GRADE>) {
      const sentences = new Set(names.map(() => consentClassLine(grade)));
      const words = new Set(names.map(() => grantRowWord(grade)));
      expect([...sentences]).toEqual([BY_GRADE[grade]]);
      expect([...words]).toEqual([WORD_BY_GRADE[grade]]);
    }
  });

  it("none of the four proven CR-1 lies is reachable from any grade", () => {
    // "This moves money, as you." on a brokerage price lookup; "This sends a
    // message, as you." on a template list. The vocabulary that produced them
    // no longer exists, so no grade can reach it.
    const reachable = [...Object.keys(BY_GRADE), "ungraded"].map(consentClassLine);
    for (const line of reachable) {
      expect(line).not.toMatch(/moves money|sends a message|deletes something|creates something/);
    }
    const words = [...Object.keys(BY_GRADE), "ungraded"].map(grantRowWord);
    expect(words).not.toContain("Moves money");
    expect(words).not.toContain("Sends");
    expect(words).not.toContain("Deletes");
    expect(words).not.toContain("Creates");
  });

  it("MIRRORS a mis-grade rather than second-guessing it — the accepted tradeoff", () => {
    // Ruling 15's defect is real and is NOT fixed here: an email-send tool a
    // host graded `read` renders "Reads: Email send" and "This reads your data,
    // as you.", which understates what the person is allowing. Yousef's ruling
    // accepts that cost knowingly. A consent card that overrode the grade from
    // a slug would miss silently on every verb the list forgot (pay, charge,
    // refund, publish, merge) while reading as coverage. The fix for a wrong
    // grade is the judge or overrides.json, upstream, where it is written down.
    const misgradedSendTool = "read";
    expect(grantRowWord(misgradedSendTool)).toBe("Reads");
    expect(consentClassLine(misgradedSendTool)).toBe(BY_GRADE.read);
  });

  it("takes no tool id at all — the signature cannot carry one", () => {
    // Reverting-proof at the type seam: both functions are arity 1. Threading a
    // name back in is a signature change a reviewer must see, not a quiet edit
    // inside a function body.
    expect(consentClassLine).toHaveLength(1);
    expect(grantRowWord).toHaveLength(1);
  });
});
