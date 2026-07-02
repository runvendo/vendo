import { describe, expect, it } from "vitest";
import { analyzeComponent } from "./analyze.js";
import { textModel } from "../test-helpers.js";

const REPLY = JSON.stringify({
  include: true,
  reason: "primitive",
  name: "Badge",
  description: "A small status badge.",
  imports: ["Badge"],
  props: [{ name: "text", type: "string", optional: false, description: "Badge text." }],
  jsx: "<Badge>{p.text}</Badge>",
});

describe("analyzeComponent", () => {
  it("returns a validated analysis", async () => {
    const a = await analyzeComponent(
      {
        file: "/x/badge.tsx",
        relFile: "src/components/ui/badge.tsx",
        exportName: "Badge",
        source: "export const Badge = () => null",
      },
      textModel([REPLY]),
    );
    expect(a.name).toBe("Badge");
    expect(a.include).toBe(true);
  });
});
