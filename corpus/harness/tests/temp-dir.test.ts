import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tempDir } from "../src/temp-dir.test-util.js";

/**
 * The teardown seam, proven on the path that actually broke.
 *
 * A green run proves nothing about a cleanup that only runs when everything
 * went right — and "everything went right" is exactly how the harness's
 * fixtures used to leak: they created a scratch dir and never removed it, so
 * /tmp grew by ~25 directories on every passing run of this package.
 *
 * So this asserts the FAILING path with no stub on either side: the first case
 * really throws after taking a directory, and the second case — a separate
 * test, reading the real filesystem — asserts the directory is gone. Vitest
 * inverts an `it.fails` result only AFTER running `onTestFinished`, so the
 * removal here happens while the test is genuinely in the failed state.
 */
describe("tempDir", () => {
  let fromFailedTest: string | undefined;
  let fromThrownFixture: string | undefined;
  let fromPassedTest: string | undefined;

  it.fails("takes a directory, then throws — the removal must not depend on the test passing", async () => {
    fromFailedTest = await tempDir("temp-dir-proof-failed-");
    expect(existsSync(fromFailedTest)).toBe(true);
    throw new Error("deliberate failure: the directory above must still be removed");
  });

  it("removed the failed test's directory", () => {
    expect(fromFailedTest, "the failing case above did not run").toBeDefined();
    expect(existsSync(fromFailedTest!)).toBe(false);
  });

  it.fails("removes a directory taken by a fixture that then throws mid-setup", async () => {
    const setUpFixture = async (): Promise<string> => {
      const dir = await tempDir("temp-dir-proof-fixture-");
      fromThrownFixture = dir;
      throw new Error("deliberate fixture failure after the dir exists");
    };
    await setUpFixture();
  });

  it("removed the thrown fixture's directory", () => {
    expect(fromThrownFixture, "the throwing fixture above did not run").toBeDefined();
    expect(existsSync(fromThrownFixture!)).toBe(false);
  });

  it("removes the directory on the passing path too", async () => {
    const dir = await tempDir("temp-dir-proof-passed-");
    expect(existsSync(dir)).toBe(true);
    // Asserted by the next case rather than here: the removal is registered
    // for after this test finishes, so it cannot be observed from inside it.
    fromPassedTest = dir;
  });

  it("removed the passing test's directory", () => {
    expect(existsSync(fromPassedTest!)).toBe(false);
  });
});
