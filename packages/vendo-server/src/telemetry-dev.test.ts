import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devTelemetry } from "./telemetry-dev.js";

describe("devTelemetry", () => {
  it("shows the first-run notice instead of burning it into a no-op sink (review)", () => {
    const home = mkdtempSync(join(tmpdir(), "vendo-dev-notice-"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      devTelemetry({ env: { NODE_ENV: "development" }, posthogKey: "phc", fetchImpl: vi.fn(), home });
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("TELEMETRY.md"))).toBe(true);
    } finally {
      errSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("emits agent_run in development", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const t = devTelemetry({ env: { NODE_ENV: "development" }, posthogKey: "phc", fetchImpl, home: undefined });
    await t.track("agent_run", {});
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("never emits in production", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const t = devTelemetry({ env: { NODE_ENV: "production" }, posthogKey: "phc", fetchImpl, home: undefined });
    await t.track("agent_run", {});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
