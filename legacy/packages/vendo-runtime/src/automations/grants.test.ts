/**
 * Grant scope-hash tests (review adjudication): the hash must cover the FULL
 * effective execution context — the granted step's whole definition (own guard
 * included), every ancestor branch/for_each predicate on the path to it, and
 * for agentic mode the goal/tools/maxToolCalls — so any scope change
 * invalidates the grant.
 */
import { describe, expect, it } from "vitest";
import { hashScope } from "./grants.js";
import { automationSpecSchema, type AutomationSpec, type AutomationStep } from "./schema.js";

function spec(overrides: Record<string, unknown> = {}): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: "Test",
    description: "test",
    prompt: "test",
    trigger: { type: "host_event", event: "transaction.created" },
    execution: {
      mode: "steps",
      steps: [
        {
          id: "size_check",
          type: "branch",
          if: "trigger.amountDollars > 500",
          then: [
            {
              id: "freeze",
              type: "tool",
              tool: "maple_freeze_card",
              input: { cardId: "{{ trigger.cardId }}" },
              if: "trigger.direction = 'debit'",
            },
          ],
        },
      ],
    },
    ...overrides,
  });
}

function freezeStep(s: AutomationSpec): AutomationStep {
  const branch = (s.execution as { steps: AutomationStep[] }).steps[0]!;
  return (branch as { then: AutomationStep[] }).then[0]!;
}

describe("hashScope effective execution context", () => {
  it("changes when the step's own guard changes", () => {
    const a = spec();
    const b = spec();
    (freezeStep(b) as { if?: string }).if = "trigger.direction = 'credit'";
    expect(hashScope(a, freezeStep(a))).not.toBe(hashScope(b, freezeStep(b)));
  });

  it("changes when an ANCESTOR branch predicate changes", () => {
    const a = spec();
    const b = spec();
    ((b.execution as { steps: AutomationStep[] }).steps[0] as { if: string }).if =
      "trigger.amountDollars > 5";
    expect(hashScope(a, freezeStep(a))).not.toBe(hashScope(b, freezeStep(b)));
  });

  it("is stable when unrelated spec parts change", () => {
    const a = spec();
    const b = spec({ name: "Renamed", description: "different" });
    expect(hashScope(a, freezeStep(a))).toBe(hashScope(b, freezeStep(b)));
  });

  it("covers goal/tools/maxToolCalls for agentic mode", () => {
    const base = {
      dslVersion: 1,
      name: "Agentic",
      description: "test",
      prompt: "test",
      trigger: { type: "composio", trigger: "GMAIL_NEW_GMAIL_MESSAGE" },
      execution: { mode: "agent", goal: "Handle it", tools: ["pay"], maxToolCalls: 5 },
    };
    const a = automationSpecSchema.parse(base);
    const b = automationSpecSchema.parse({
      ...base,
      execution: { mode: "agent", goal: "Handle it", tools: ["pay"], maxToolCalls: 25 },
    });
    expect(hashScope(a, null)).not.toBe(hashScope(b, null));
  });
});
