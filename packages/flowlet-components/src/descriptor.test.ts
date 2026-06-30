import { describe, it, expect } from "vitest";
import { z } from "zod";
import { prewired, jsonValue } from "./descriptor";

describe("prewired()", () => {
  it("builds a descriptor and a RegisteredComponent stamped prewired", () => {
    const d = prewired("Demo", "a demo", z.object({ title: z.string() }));
    expect(d.name).toBe("Demo");
    expect(d.toRegistered().source).toBe("prewired");
    expect(d.toRegistered().name).toBe("Demo");
  });

  it("jsonValue accepts JSON data and rejects non-JSON", () => {
    expect(jsonValue.safeParse({ a: [1, "x", true, null] }).success).toBe(true);
    expect(jsonValue.safeParse(() => 1).success).toBe(false);
    expect(jsonValue.safeParse(new Date()).success).toBe(false);
  });
});
