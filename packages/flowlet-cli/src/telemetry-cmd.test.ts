import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTelemetryCmd } from "./telemetry-cmd.js";
import { loadConfig } from "@flowlet/telemetry";

describe("runTelemetryCmd", () => {
  it("disable then status reports opted out", () => {
    const home = mkdtempSync(join(tmpdir(), "flowlet-cli-tele-"));
    try {
      const out: string[] = [];
      const log = (m: string) => out.push(m);
      expect(runTelemetryCmd("disable", { home, log })).toBe(0);
      expect(loadConfig(home).optedOut).toBe(true);
      runTelemetryCmd("status", { home, log });
      expect(out.join("\n")).toContain("disabled");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("enable clears opt-out", () => {
    const home = mkdtempSync(join(tmpdir(), "flowlet-cli-tele2-"));
    try {
      runTelemetryCmd("disable", { home, log: () => {} });
      expect(runTelemetryCmd("enable", { home, log: () => {} })).toBe(0);
      expect(loadConfig(home).optedOut).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("unknown subcommand returns non-zero", () => {
    expect(runTelemetryCmd("bogus", { home: undefined, log: () => {} })).toBe(1);
  });
});
