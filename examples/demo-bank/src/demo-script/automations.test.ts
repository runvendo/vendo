/**
 * The sweep automation moves MONEY, and its amount is computed by a JSONata
 * expression over a live read — so the arithmetic is asserted here against the
 * real listTransactions payload shape (`ok(listTransactions(q))` =>
 * `{ data: { data: Transaction[], nextCursor, total } }`, amounts in cents,
 * negative = debit).
 *
 * Getting this wrong is not a cosmetic bug: the resolved amount is what the
 * rehearsal card shows a user before they consent to a standing transfer.
 */
import { VENDO_APP_FORMAT, appDocumentSchema, type Step } from "@vendoai/core";
import jsonata from "jsonata";
import { describe, expect, it } from "vitest";
import { demoAppId, mapleDemoAutomations } from "./automations";

const SUBJECT = "user_maple_demo";
const docs = () => mapleDemoAutomations(SUBJECT);
const sweep = () => docs().find(d => d.id === demoAppId("sweep", SUBJECT))!;

const stepsOf = (doc: ReturnType<typeof sweep>): Step[] => {
  const run = doc.triggers![0]!.run;
  if (run.kind !== "steps") throw new Error(`${doc.id} is not a steps automation`);
  return run.steps;
};

const sweepStep = () => stepsOf(sweep()).find(s => s.tool === "host_transferMoney")!;

/** One week of the shape host_listTransactions really returns. */
const week = (rows: Array<{ amount: number; category: string }>) => ({
  steps: {
    week: { data: { data: rows.map((r, i) => ({ id: `txn_${i}`, ...r })), total: rows.length } },
  },
  event: {},
  item: undefined,
});

const evaluate = async (expression: string, input: unknown) =>
  await jsonata(expression).evaluate(input);

describe("mapleDemoAutomations", () => {
  it("builds valid AppDocuments, id-scoped to the subject", () => {
    for (const doc of docs()) {
      expect(() => appDocumentSchema.parse(doc)).not.toThrow();
      expect(doc.format).toBe(VENDO_APP_FORMAT);
      expect(doc.id).toContain(SUBJECT);
    }
    expect(new Set(docs().map(d => d.id)).size).toBe(docs().length);
  });

  it("is rehearsable: schedule triggers, steps runs, host tools only", () => {
    for (const doc of docs()) {
      expect(doc.triggers?.[0]?.on.kind).toBe("schedule");
      expect(doc.triggers?.[0]?.run.kind).toBe("steps");
      for (const step of stepsOf(doc)) {
        // fn: steps report "app function calls don't execute in rehearsal".
        expect(step.tool.startsWith("host_")).toBe(true);
      }
    }
  });

  it("reaches a destructive tool — the point of the set", () => {
    const tools = docs().flatMap(d => stepsOf(d)).map(s => s.tool);
    expect(tools).toContain("host_transferMoney");
  });

  it("pins a page limit above a week's volume, so the sweep cannot under-count", () => {
    const read = stepsOf(sweep()).find(s => s.tool === "host_listTransactions")!;
    // listTransactions defaults to a 25-row page; the seed makes 0-3 a day.
    expect(Number(read.args!["limit"])).toBeGreaterThan(25);
  });
});

describe("sweep amount", () => {
  it("is 10% of the week's spend, in whole cents", async () => {
    const input = week([
      { amount: -1250, category: "coffee" },
      { amount: -8640, category: "groceries" },
      { amount: -2310, category: "transport" },
    ]);
    // 12,200 cents spent -> 1,220 cents swept.
    expect(await evaluate(sweepStep().args!["amount"]!, input)).toBe(1220);
  });

  it("ignores income and internal transfers — neither is money spent", async () => {
    const input = week([
      { amount: -1250, category: "coffee" },
      { amount: 642000, category: "income" },
      { amount: -100000, category: "transfer" },
    ]);
    expect(await evaluate(sweepStep().args!["amount"]!, input)).toBe(125);
  });

  it("rounds to a whole cent — host_transferMoney takes an integer", async () => {
    const input = week([{ amount: -333, category: "coffee" }])
    const amount = await evaluate(sweepStep().args!["amount"]!, input);
    expect(Number.isInteger(amount)).toBe(true);
    expect(amount).toBe(33);
  });

  it("names the amount in the memo the user will read on the card", async () => {
    const input = week([{ amount: -8640, category: "groceries" }]);
    expect(await evaluate(sweepStep().args!["memo"]!, input))
      .toBe("Auto-sweep: 10% of 86.40 spent this week");
  });

  it("skips a spendless week rather than sending a zero transfer", async () => {
    const spendless = week([
      { amount: 642000, category: "income" },
      { amount: -100000, category: "transfer" },
    ]);
    expect(await evaluate(sweepStep().if!, spendless)).toBe(false);
    // The guard is what stops it: the amount alone would resolve to nothing,
    // and the tool requires a positive integer.
    expect(await evaluate(sweepStep().args!["amount"]!, spendless)).toBeUndefined();

    const spending = week([{ amount: -1250, category: "coffee" }]);
    expect(await evaluate(sweepStep().if!, spending)).toBe(true);
  });
});
