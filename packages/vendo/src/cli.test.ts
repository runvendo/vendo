import { describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

describe("vendo CLI commands", () => {
  it("keeps help aligned with the four-question init and its non-interactive flags", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await main(["--help"])).toBe(0);
    const help = log.mock.calls.flat().join("\n");
    expect(help).toContain("four questions");
    expect(help).toContain("--yes");
    expect(help).toContain("--force");
    expect(help).toContain("--model-import <specifier>");
    expect(help).toContain("--brief <text>");
    expect(help).toContain("--json");

    log.mockRestore();
  });

  it("exposes init, doctor, and sync only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["refresh"])).toBe(1);
    expect(await main(["telemetry", "status"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("Unknown command");
    error.mockRestore();
  });

  it("wires the mcp subcommand group", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["mcp", "--help"])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("vendo mcp server-json");
    log.mockRestore();
  });
});
