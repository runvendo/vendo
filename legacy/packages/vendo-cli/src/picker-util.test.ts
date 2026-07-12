import { describe, expect, it } from "vitest";
import { disambiguatedLabels, truncateHint, MAX_HINT_CHARS } from "./picker-util.js";

describe("disambiguatedLabels", () => {
  const nameOf = (t: { name: string; path: string }) => t.name;
  const pathOf = (t: { name: string; path: string }) => t.path;

  it("keeps unique names bare and appends the path only to duplicates", () => {
    const items = [
      { name: "Card", path: "a/Card.tsx" },
      { name: "Card", path: "b/Card.tsx" },
      { name: "Badge", path: "ui/Badge.tsx" },
    ];
    const label = disambiguatedLabels(items, nameOf, pathOf);
    expect(items.map(label)).toEqual([
      "Card (a/Card.tsx)",
      "Card (b/Card.tsx)",
      "Badge",
    ]);
  });
});

describe("truncateHint", () => {
  it("passes short hints through unchanged", () => {
    expect(truncateHint("a list of things")).toBe("a list of things");
  });

  it("truncates over-long hints with an ellipsis", () => {
    const long = "x".repeat(MAX_HINT_CHARS + 10);
    const out = truncateHint(long);
    expect(out.length).toBe(MAX_HINT_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});
