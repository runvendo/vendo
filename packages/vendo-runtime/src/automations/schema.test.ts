/**
 * DSL schema tests. The four fixtures are the worked examples from the
 * original automations design, verbatim — if the design and the schema
 * drift, these tests catch it.
 */
import { describe, expect, it } from "vitest";
import { automationSpecSchema } from "./schema.js";

const example1 = {
  dslVersion: 1,
  name: "Late-night delivery snitch",
  description: "Post to #general when a late-night food delivery charge posts",
  prompt: "snitch on me in #general if I order food delivery late at night",
  trigger: { type: "host_event", event: "transaction.created" },
  if: "trigger.direction = 'debit' and trigger.hour >= 0 and trigger.hour < 5 and trigger.category = 'dining' and ($contains($lowercase(trigger.merchant & ' ' & trigger.descriptor), 'delivery') or $contains($lowercase(trigger.merchant), 'doordash') or $contains($lowercase(trigger.merchant), 'grubhub') or $contains($lowercase(trigger.merchant), 'uber eats'))",
  execution: {
    mode: "steps",
    steps: [
      {
        id: "snitch",
        type: "tool",
        tool: "SLACK_SEND_MESSAGE",
        input: {
          channel: "#general",
          text: "Late-night delivery alert: {{ user.name }} just ordered *{{ trigger.merchant }}* (${{ trigger.amountDollars }}) at {{ trigger.time }}. He set up this alert to snitch on himself. Someone stage an intervention.",
        },
      },
    ],
  },
};

const example2 = {
  dslVersion: 1,
  name: "Weekly spending digest",
  description: "Every Sunday 5pm, summarize the week's spending and email it to me",
  prompt: "email me a spending recap every Sunday evening",
  trigger: { type: "schedule", cron: "0 17 * * 0", timezone: "America/Los_Angeles" },
  execution: {
    mode: "steps",
    steps: [
      {
        id: "fetch",
        type: "tool",
        tool: "maple_list_transactions",
        input: {
          since: "{{ $fromMillis($toMillis(run.firedAt) - 7*24*60*60*1000) }}",
          limit: 200,
        },
      },
      {
        id: "digest",
        type: "agent",
        goal: "Write a friendly, concise weekly spending digest: total spent, top 3 categories, anything unusual versus a typical week. Plain text, no markdown tables.",
        input: { transactions: "{{ steps.fetch.output.data }}" },
        tools: [],
        output: {
          type: "object",
          properties: { subject: { type: "string" }, body: { type: "string" } },
          required: ["subject", "body"],
        },
      },
      {
        id: "send",
        type: "tool",
        tool: "GMAIL_SEND_EMAIL",
        input: {
          to: "{{ user.email }}",
          subject: "{{ steps.digest.output.subject }}",
          body: "{{ steps.digest.output.body }}",
        },
        onError: { strategy: "retry", attempts: 3 },
      },
    ],
  },
};

const example3 = {
  dslVersion: 1,
  name: "Big charge card freeze",
  description: "On any debit over $500: freeze the card, then notify me on Slack",
  prompt: "if any charge over $500 hits my card, freeze it and let me know",
  trigger: { type: "host_event", event: "transaction.created" },
  if: "trigger.direction = 'debit' and trigger.amountDollars > 500 and $exists(trigger.cardId)",
  execution: {
    mode: "steps",
    steps: [
      {
        id: "freeze",
        type: "tool",
        tool: "maple_freeze_card",
        input: { cardId: "{{ trigger.cardId }}", reason: "Automated freeze: charge over $500" },
      },
      {
        id: "notify",
        type: "tool",
        tool: "SLACK_SEND_MESSAGE",
        input: {
          channel: "#alerts",
          text: "Froze your card: {{ trigger.merchant }} charged ${{ trigger.amountDollars }}. Unfreeze from the Maple dashboard if this was you.",
        },
        onError: { strategy: "continue" },
      },
    ],
  },
};

const example4 = {
  dslVersion: 1,
  name: "Rent invoice autopay",
  description: "When landlord emails an invoice: schedule the payment from checking, reply to confirm",
  prompt: "when my landlord emails me the monthly invoice, schedule the rent payment and reply to confirm",
  trigger: {
    type: "composio",
    trigger: "GMAIL_NEW_GMAIL_MESSAGE",
    config: { labelIds: "INBOX" },
  },
  if: "$contains($lowercase(trigger.sender), 'landlord@example.com')",
  execution: {
    mode: "agent",
    goal: "The trigger payload is a new email from my landlord. If it contains a rent invoice, extract the amount and due date, schedule a payment from my checking account for one day before the due date, and reply to the email confirming the scheduled date and amount. If it is not an invoice, do nothing.",
    tools: ["maple_list_accounts", "maple_schedule_payment", "GMAIL_REPLY_TO_EMAIL"],
    maxToolCalls: 15,
  },
};

/** Deep-clone helper so mutation-based negative tests never share fixtures. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("automationSpecSchema: worked examples", () => {
  it("parses example 1 (deterministic, host event)", () => {
    expect(automationSpecSchema.parse(example1)).toBeTruthy();
  });

  it("parses example 2 (hybrid, schedule)", () => {
    expect(automationSpecSchema.parse(example2)).toBeTruthy();
  });

  it("parses example 3 (deterministic, danger-gated step)", () => {
    expect(automationSpecSchema.parse(example3)).toBeTruthy();
  });

  it("parses example 4 (fully agentic, composio trigger)", () => {
    expect(automationSpecSchema.parse(example4)).toBeTruthy();
  });
});

describe("automationSpecSchema: validation rules", () => {
  it("rejects a dslVersion other than 1", () => {
    const spec = clone(example1);
    (spec as { dslVersion: number }).dslVersion = 2;
    expect(automationSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects kebab-case step ids (JSONata parses dashes as subtraction)", () => {
    const spec = clone(example3);
    spec.execution.steps[0]!.id = "freeze-card";
    expect(automationSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects duplicate step ids, including across nesting levels", () => {
    const spec = clone(example1);
    spec.execution.steps.push({
      id: "wrap",
      type: "branch",
      if: "true",
      then: [
        {
          id: "snitch", // duplicates the top-level step id
          type: "tool",
          tool: "SLACK_SEND_MESSAGE",
          input: { channel: "#general", text: "dup" },
        },
      ],
    } as never);
    expect(automationSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects more than 25 total steps (counting nested)", () => {
    const spec = clone(example1);
    spec.execution.steps = Array.from({ length: 26 }, (_, i) => ({
      id: `step_${i}`,
      type: "tool",
      tool: "SLACK_SEND_MESSAGE",
      input: { channel: "#general", text: "hi" },
    })) as never;
    expect(automationSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects for_each maxItems above 100 and defaults it to 100", () => {
    const base = clone(example1);
    base.execution.steps = [
      {
        id: "loop",
        type: "for_each",
        items: "{{ trigger.rows }}",
        steps: [
          { id: "inner", type: "tool", tool: "SLACK_SEND_MESSAGE", input: { channel: "#g", text: "x" } },
        ],
      },
    ] as never;

    const parsed = automationSpecSchema.parse(base);
    const loop = (parsed.execution as { steps: Array<{ maxItems?: number }> }).steps[0]!;
    expect(loop.maxItems).toBe(100);

    const over = clone(base);
    (over.execution.steps[0] as { maxItems?: number }).maxItems = 101;
    expect(automationSpecSchema.safeParse(over).success).toBe(false);
  });

  it("rejects a for_each `as` name that shadows the expression scope", () => {
    const spec = clone(example1);
    spec.execution.steps = [
      {
        id: "loop",
        type: "for_each",
        items: "{{ trigger.rows }}",
        as: "trigger",
        steps: [
          { id: "inner", type: "tool", tool: "SLACK_SEND_MESSAGE", input: { channel: "#g", text: "x" } },
        ],
      },
    ] as never;
    expect(automationSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects agentic mode with an empty tools allowlist", () => {
    const spec = clone(example4);
    (spec.execution as { tools: string[] }).tools = [];
    expect(automationSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("allows an agent STEP with an empty tools allowlist (pure judgment)", () => {
    expect(automationSpecSchema.safeParse(example2).success).toBe(true);
  });

  it("rejects a schedule trigger with both cron and at", () => {
    const spec = clone(example2);
    (spec.trigger as Record<string, unknown>).at = "2026-07-15T09:00:00-07:00";
    expect(automationSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects a cron schedule without a timezone", () => {
    const spec = clone(example2);
    delete (spec.trigger as Record<string, unknown>).timezone;
    expect(automationSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("accepts a one-shot `at` schedule without cron or timezone", () => {
    const spec = clone(example2);
    spec.trigger = { type: "schedule", at: "2026-07-15T09:00:00-07:00" } as never;
    expect(automationSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("rejects empty steps in steps mode", () => {
    const spec = clone(example1);
    spec.execution.steps = [] as never;
    expect(automationSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects a maxFiringsPerHour above the 60 ceiling", () => {
    const spec = clone(example1);
    (spec as Record<string, unknown>).limits = { maxFiringsPerHour: 61 };
    expect(automationSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects retry with more than 5 attempts", () => {
    const spec = clone(example2);
    (spec.execution.steps[2] as { onError: { strategy: string; attempts: number } }).onError = {
      strategy: "retry",
      attempts: 6,
    };
    expect(automationSpecSchema.safeParse(spec).success).toBe(false);
  });
});
