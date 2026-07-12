import { describe, expect, it } from "vitest";
import { buildAutomationInstructions } from "./instructions.js";

describe("buildAutomationInstructions", () => {
  it("teaches the compiler rules and lists the declared host events", () => {
    const text = buildAutomationInstructions({
      hostEvents: [
        {
          name: "transaction.created",
          description: "A Maple transaction posted",
          payloadFields:
            "id, merchant, descriptor, category, hour (0-24), time, amountDollars, direction (debit|credit), cardId?",
        },
      ],
    });
    expect(text).toContain("create_automation");
    expect(text).toContain("transaction.created");
    expect(text).toContain("amountDollars");
    expect(text).toMatch(/deterministic/i);
    expect(text).toMatch(/JSONata/);
    expect(text).toMatch(/snake_case/);
    expect(text).toMatch(/grantedTools/);
    expect(text).toMatch(/dry-run|dry run/i);
  });

  it("works with no host events declared", () => {
    const text = buildAutomationInstructions();
    expect(text).toContain("create_automation");
    expect(text).toMatch(/no host events/i);
  });
});
