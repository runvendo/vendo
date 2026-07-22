import { describe, expect, it } from "vitest";
import { e2bInstalled } from "./index.js";

/** 0.4.4 defect C — e2bInstalled must test USABILITY (the runtime can resolve
 *  the SDK), never blanket-pass: the old "no import.meta.resolve ⇒ bundler
 *  inlined it ⇒ available" fallback claimed e2b inside Turbopack server
 *  bundles on hosts without the SDK, flipping the venue ladder away from the
 *  Cloud sandbox. */
describe("e2bInstalled", () => {
  it("is true when the SDK resolves from this runtime (a devDependency here)", () => {
    expect(e2bInstalled()).toBe(true);
  });

  it("is false when the specifier does not resolve — the probe asks the runtime's resolver instead of assuming availability", () => {
    expect(e2bInstalled("vendo-test-not-an-installed-sdk")).toBe(false);
  });
});
