import { expect, it } from "vitest";

if (process.env.POSTGRES_URL) {
  it("postgres leg configured", () => {});
} else if (process.env.CI === "true") {
  it("postgres leg is required in CI", () => {
    expect.fail("POSTGRES_URL must be set in CI so the PostgreSQL backend suite runs");
  });
} else {
  it.skip("postgres leg skipped — POSTGRES_URL not set");
}
