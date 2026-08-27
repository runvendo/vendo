/**
 * The shell's config surface: the SAME shape `mcp` has — a boolean for the
 * decision, an object for the decision plus its knobs. Default ON.
 *
 * A type has no runtime, so the shape's assertions are the compiler's and
 * `tsc -p tsconfig.test.json` is where they bite. Each `@ts-expect-error` is
 * itself an assertion: it fails the build the day the surface widens enough to
 * accept what it refuses today.
 */
import { describe, expect, it } from "vitest";
import { CREATE_VENDO_CONFIG_KEYS } from "../src/config-keys.js";
import type { CreateVendoConfig } from "../src/types.js";

type Shell = CreateVendoConfig["shell"];

export const off: Shell = false;
export const on: Shell = true;
export const tuned: Shell = { limits: { maxExecutionTimeMs: 5_000, maxOutputBytes: 4_096 } };

// @ts-expect-error — `limits` is the only member; a near-miss must not pass silently.
export const typo: Shell = { limit: { maxExecutionTimeMs: 5_000 } };
// @ts-expect-error — the ceilings are a number of milliseconds and a number of bytes.
export const wrongUnit: Shell = { limits: { maxExecutionTimeMs: "5s" } };
// @ts-expect-error — two knobs, and only two: just-bash 3.4.2's QuickJS memory
// ceiling is a compiled-in constant, so a `jsMemoryBytes` nothing could read
// would be a lie in a public type.
export const unimplementable: Shell = { limits: { jsMemoryBytes: 1_000_000 } };

describe("createVendo({ shell })", () => {
  it("is a key the closed config list accepts", () => {
    expect(CREATE_VENDO_CONFIG_KEYS).toContain("shell");
  });
});
