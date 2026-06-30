/**
 * The Flowlet-layer rules store — the natural-language guardrails the agent
 * sets in Beat 3 ("post to #general on any late-night delivery"). This is
 * distinct from the agent's approval policy, which gates *tool calls*; rules
 * react to *events* (new transactions) detected by the poller.
 *
 * In-memory + module-level, like Maple's own store. Reset clears it.
 */

export interface RuleTrigger {
  /** Only fire for charges between 12am and 5am (Pacific). */
  lateNightOnly?: boolean;
  /** Restrict to these Maple categories (e.g. ["dining"]). Empty = any. */
  categories?: string[];
  /** Merchant/descriptor keywords, case-insensitive (e.g. ["doordash","delivery"]). */
  keywords?: string[];
}

export interface Rule {
  id: string;
  description: string;
  channel: string;
  trigger: RuleTrigger;
  createdAt: string;
}

/** The minimal transaction shape the matcher needs. */
export interface TxLike {
  merchant: string;
  descriptor: string;
  category: string;
  hour: number; // 0-24, Pacific
  amountDollars: number;
  direction: "debit" | "credit";
}

const LATE_START = 0;
const LATE_END = 5;

let rules: Rule[] = [];
let counter = 0;

export function addRule(input: {
  description: string;
  channel?: string;
  trigger: RuleTrigger;
  createdAt?: string;
}): Rule {
  const rule: Rule = {
    id: `rule-${++counter}`,
    description: input.description,
    channel: input.channel?.trim() || "general",
    trigger: input.trigger,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  rules.push(rule);
  return rule;
}

export function listRules(): Rule[] {
  return rules.slice();
}

export function clearRules(): void {
  rules = [];
  counter = 0;
}

export function ruleMatches(rule: Rule, tx: TxLike): boolean {
  if (tx.direction !== "debit") return false;
  const t = rule.trigger;
  if (t.lateNightOnly && !(tx.hour >= LATE_START && tx.hour < LATE_END)) return false;
  if (t.categories && t.categories.length > 0 && !t.categories.includes(tx.category)) {
    return false;
  }
  if (t.keywords && t.keywords.length > 0) {
    const hay = `${tx.merchant} ${tx.descriptor}`.toLowerCase();
    if (!t.keywords.some((k) => hay.includes(k.toLowerCase()))) return false;
  }
  return true;
}

/** All active rules that match a transaction. */
export function matchRules(tx: TxLike): Rule[] {
  return rules.filter((r) => ruleMatches(r, tx));
}
