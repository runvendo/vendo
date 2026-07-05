import { describe, it, expect, vi } from "vitest";
import { devTelemetry } from "./telemetry-dev.js";

describe("devTelemetry", () => {
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
