import { describe, it, expect } from "vitest";
import { stripEmoji, stripEmojiDeep } from "./text.js";

describe("stripEmoji", () => {
  it("removes emoji and tidies whitespace", () => {
    expect(stripEmoji("🌮 DoorDash — Taco Bell")).toBe("DoorDash — Taco Bell");
    expect(stripEmoji("Late-night alert 🚨🌮🌙")).toBe("Late-night alert");
    expect(stripEmoji("Done ✅.")).toBe("Done.");
  });

  it("leaves plain text untouched", () => {
    expect(stripEmoji("This month at a glance")).toBe("This month at a glance");
    expect(stripEmoji("$87.00 at 1:14 AM")).toBe("$87.00 at 1:14 AM");
  });

  it("strips ZWJ-composed and flag emoji", () => {
    expect(stripEmoji("family 👨‍👩‍👧 here")).toBe("family here");
    expect(stripEmoji("flag 🇺🇸 done")).toBe("flag done");
  });
});

describe("stripEmojiDeep", () => {
  it("recurses through objects and arrays", () => {
    const input = {
      title: "Receipt 🌮",
      tags: ["DoorDash 🛵", "Taco Bell"],
      nested: { body: "Total: $87 💸" },
      amount: 8700,
    };
    expect(stripEmojiDeep(input)).toEqual({
      title: "Receipt",
      tags: ["DoorDash", "Taco Bell"],
      nested: { body: "Total: $87" },
      amount: 8700,
    });
  });
});
