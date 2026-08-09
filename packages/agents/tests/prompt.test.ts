import { describe, expect, it } from "vitest";
import { assemblePrompt } from "../src/prompt.js";

describe("prompt assembly", () => {
  it("orders sections: base rules, instructions, [User], [Situation], directions", () => {
    const prompt = assemblePrompt({
      instructions: "Answer as the Acme support desk.",
      user: { name: "Dana", plan: "pro" },
      situation: { page: "/billing" },
      directions: ["Prefer refunds under $50."],
    });
    const order = [
      "You are an agent embedded in the host application",
      "Answer as the Acme support desk.",
      "[User]",
      "name: Dana",
      "plan: pro",
      "[Situation]",
      "page: /billing",
      "Directions",
      "- Prefer refunds under $50.",
    ];
    let at = -1;
    for (const marker of order) {
      const next = prompt.indexOf(marker);
      expect(next, `expected "${marker}" after position ${at}`).toBeGreaterThan(at);
      at = next;
    }
  });

  it("skips every empty section rather than emitting bare headers", () => {
    const prompt = assemblePrompt({});
    expect(prompt).not.toContain("[User]");
    expect(prompt).not.toContain("[Situation]");
    expect(prompt).not.toContain("Directions");
    expect(prompt).toContain("You are an agent");
  });

  it("drops function-valued situation entries — they run at check-time, never in the prompt", () => {
    const prompt = assemblePrompt({
      situation: { record: "inv_7", lookup: () => "secret" },
    });
    expect(prompt).toContain("record: inv_7");
    expect(prompt).not.toContain("lookup");
    expect(prompt).not.toContain("secret");
  });

  it("serializes non-string facts as JSON", () => {
    const prompt = assemblePrompt({ user: { seats: 4, admin: true } });
    expect(prompt).toContain("seats: 4");
    expect(prompt).toContain("admin: true");
  });
});
