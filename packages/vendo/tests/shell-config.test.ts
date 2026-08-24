/**
 * The shell's config surface: the SAME shape `mcp` has — a boolean for the
 * decision, an object for the decision plus its knobs. Default ON.
 */
import { describe, expect, it } from "vitest";
import type { CreateVendoConfig } from "../src/types.js";

describe("createVendo({ shell })", () => {
  it("takes a boolean or an object carrying limits", () => {
    const off: CreateVendoConfig["shell"] = false;
    const on: CreateVendoConfig["shell"] = true;
    const tuned: CreateVendoConfig["shell"] = { limits: { maxExecutionTimeMs: 5_000, maxOutputBytes: 4_096 } };

    expect([off, on, tuned]).toHaveLength(3);
  });
});
