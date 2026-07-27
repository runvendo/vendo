import { describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

describe("vendo playground retirement", () => {
  it("fails with a one-liner pointing at vendo try", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["playground"])).toBe(1);
    const printed = error.mock.calls.flat().join("\n");
    expect(printed).toContain("vendo try");
    expect(printed).toContain("retired");
    error.mockRestore();
  });

  it("points at vendo try even when the old flags ride along", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["playground", "--port", "4123", "--no-open"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("vendo try");
    error.mockRestore();
  });

  it("--help lists try, not playground", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["--help"])).toBe(0);
    const help = log.mock.calls.flat().join("\n");
    expect(help).toContain("try");
    expect(help).not.toContain("playground");
    log.mockRestore();
  });
});
