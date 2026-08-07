import { describe, expect, it } from "vitest";
import {
  appIdSchema,
  approvalIdSchema,
  grantIdSchema,
  runIdSchema,
  threadIdSchema,
} from "../index.js";

// Light regression suite for the prefix-typed id schemas (01-core §1). These
// schemas only assert the TYPE PREFIX — they are a cheap tripwire against an id
// from the wrong namespace being accepted where another kind is expected. The
// actual CSPRNG minting of id bodies lives in the blocks and is asserted in the
// apps interchange lane, not here.

const cases: Array<{ name: string; schema: { safeParse: (v: unknown) => { success: boolean } }; prefix: string }> = [
  { name: "appId", schema: appIdSchema, prefix: "app_" },
  { name: "grantId", schema: grantIdSchema, prefix: "grt_" },
  { name: "approvalId", schema: approvalIdSchema, prefix: "apr_" },
  { name: "runId", schema: runIdSchema, prefix: "run_" },
  { name: "threadId", schema: threadIdSchema, prefix: "thr_" },
];

describe("id prefix schemas", () => {
  for (const { name, schema, prefix } of cases) {
    it(`${name} accepts its own prefix and rejects wrong / absent prefixes`, () => {
      expect(schema.safeParse(`${prefix}abc123`).success).toBe(true);

      // Bare body with no prefix.
      expect(schema.safeParse("abc123").success).toBe(false);
      // Empty string.
      expect(schema.safeParse("").success).toBe(false);
      // A prefix-only value (regex requires at least one body character).
      expect(schema.safeParse(prefix).success).toBe(false);
      // Every OTHER kind's prefix must be rejected — ids are not cross-assignable.
      for (const other of cases) {
        if (other.prefix === prefix) continue;
        expect(schema.safeParse(`${other.prefix}abc123`).success).toBe(false);
      }
    });
  }

  it("rejects non-string ids", () => {
    for (const value of [42, null, undefined, {}, ["app_x"]]) {
      expect(appIdSchema.safeParse(value).success).toBe(false);
    }
  });
});
