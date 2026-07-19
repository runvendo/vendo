import { describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";
import { runPlayground } from "./cli/playground.js";

vi.mock("./cli/playground.js", () => ({ runPlayground: vi.fn(async () => 0) }));

const runPlaygroundMock = vi.mocked(runPlayground);

describe("vendo playground CLI wiring", () => {
  it("lists playground in --help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["--help"])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("playground");
    log.mockRestore();
  });

  it("passes --port and --no-open through to the command", async () => {
    expect(await main(["playground", "--port", "4123", "--no-open"])).toBe(0);
    expect(runPlaygroundMock).toHaveBeenCalledWith(expect.objectContaining({ port: 4123, open: false }));
  });

  it("defaults to opening the browser on an automatic port", async () => {
    runPlaygroundMock.mockClear();
    expect(await main(["playground"])).toBe(0);
    const options = runPlaygroundMock.mock.calls[0]?.[0] ?? {};
    expect(options.port).toBeUndefined();
    expect(options.open).not.toBe(false);
  });

  it("rejects unknown options and bad ports instead of silently proceeding", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runPlaygroundMock.mockClear();

    expect(await main(["playground", "--watch"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--watch");

    expect(await main(["playground", "--port", "not-a-port"])).toBe(1);
    expect(await main(["playground", "--port"])).toBe(1);
    expect(runPlaygroundMock).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
