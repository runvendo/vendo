import { describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";
import { runTry } from "./cli/try.js";

vi.mock("./cli/try.js", () => ({ runTry: vi.fn(async () => 0) }));

const runTryMock = vi.mocked(runTry);

describe("vendo try CLI wiring", () => {
  it("lists try in --help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["--help"])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("try");
    log.mockRestore();
  });

  it("passes --port, --no-open, --no-ai, and --engine through to the command", async () => {
    expect(await main(["try", "--port", "4123", "--no-open", "--no-ai", "--engine", "claude"])).toBe(0);
    expect(runTryMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4123, open: false, ai: false, engine: "claude" }),
    );
  });

  it("defaults to opening the browser, AI on, an automatic port, no engine pin", async () => {
    runTryMock.mockClear();
    expect(await main(["try"])).toBe(0);
    const options = runTryMock.mock.calls[0]?.[0] ?? {};
    expect(options.port).toBeUndefined();
    expect(options.engine).toBeUndefined();
    expect(options.open).not.toBe(false);
    expect(options.ai).not.toBe(false);
  });

  it("rejects unknown options, stray arguments, and bad ports instead of silently proceeding", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runTryMock.mockClear();

    expect(await main(["try", "--bogus"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--bogus");

    expect(await main(["try", "some-dir"])).toBe(1);
    // A stray positional explains itself instead of a bare rejection.
    expect(error.mock.calls.flat().join("\n")).toContain("try profiles the current directory");
    expect(await main(["try", "--port", "not-a-port"])).toBe(1);
    expect(await main(["try", "--port"])).toBe(1);
    expect(runTryMock).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("rejects an unknown engine family, naming the valid ones", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runTryMock.mockClear();

    expect(await main(["try", "--engine", "bogus"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("claude, codex, npx");

    expect(await main(["try", "--engine"])).toBe(1);
    expect(runTryMock).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
