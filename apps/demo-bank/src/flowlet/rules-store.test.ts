import { describe, it, expect, beforeEach } from "vitest";
import { addRule, clearRules, matchRules, ruleMatches, type TxLike } from "./rules-store";

const lateNightDoorDash: TxLike = {
  merchant: "DoorDash",
  descriptor: "DOORDASH*ORDER 8742 CA",
  category: "dining",
  hour: 1.23,
  amountDollars: 87,
  direction: "debit",
};

const daytimeGroceries: TxLike = {
  merchant: "Whole Foods",
  descriptor: "WHOLEFDS",
  category: "groceries",
  hour: 14,
  amountDollars: 52,
  direction: "debit",
};

describe("rules-store", () => {
  beforeEach(() => clearRules());

  it("matches a late-night delivery charge but not daytime groceries", () => {
    addRule({
      description: "Post to #general on any late-night delivery",
      channel: "general",
      trigger: { lateNightOnly: true, categories: ["dining"], keywords: ["doordash", "delivery"] },
    });
    expect(matchRules(lateNightDoorDash)).toHaveLength(1);
    expect(matchRules(daytimeGroceries)).toHaveLength(0);
  });

  it("does not match the same delivery during the day", () => {
    const rule = addRule({
      description: "late-night delivery",
      trigger: { lateNightOnly: true, keywords: ["doordash"] },
    });
    expect(ruleMatches(rule, { ...lateNightDoorDash, hour: 13 })).toBe(false);
    expect(ruleMatches(rule, lateNightDoorDash)).toBe(true);
  });

  it("ignores credits (incoming money)", () => {
    const rule = addRule({ description: "any", trigger: { keywords: ["doordash"] } });
    expect(ruleMatches(rule, { ...lateNightDoorDash, direction: "credit" })).toBe(false);
  });

  it("defaults channel to general", () => {
    const rule = addRule({ description: "x", trigger: {} });
    expect(rule.channel).toBe("general");
  });
});
