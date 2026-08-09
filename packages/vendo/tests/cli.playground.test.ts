import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

describe("vendo playground retirement", () => {
  it("fails with a one-liner pointing at the install path", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["playground"])).toBe(1);
    const printed = error.mock.calls.flat().join("\n");
    expect(printed).toContain("vendo init");
    expect(printed).toContain("retired");
    // `try` is unlisted (self-serve audit B1) — a retirement notice must not
    // send the next stranger at a command help does not name.
    expect(printed).not.toContain("vendo try");
    error.mockRestore();
  });

  it("says the same thing when the old flags ride along", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["playground", "--port", "4123", "--no-open"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("vendo init");
    error.mockRestore();
  });

  it("--help lists neither playground nor the unlisted try", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["--help"])).toBe(0);
    const help = log.mock.calls.flat().join("\n");
    expect(help).not.toMatch(/\btry\b/);
    expect(help).not.toContain("playground");
    log.mockRestore();
  });
});
