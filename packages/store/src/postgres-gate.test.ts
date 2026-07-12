import { it } from "vitest";

if (process.env.POSTGRES_URL) {
  it("postgres leg configured", () => {});
} else {
  it.skip("postgres leg skipped — POSTGRES_URL not set");
}
