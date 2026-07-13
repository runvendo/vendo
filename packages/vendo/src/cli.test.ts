import { describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

describe("vendo CLI commands", () => {
  it("exposes init, doctor, and sync only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["refresh"])).toBe(1);
    expect(await main(["telemetry", "status"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("Unknown command");
    error.mockRestore();
  });
});
