import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTelemetry } from "./index.js";

describe("initTelemetry", () => {
  it("wires config + notice + client and can track", async () => {
    const home = mkdtempSync(join(tmpdir(), "flowlet-tele-idx-"));
    try {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
      const log = vi.fn();
      const t = initTelemetry({
        version: "3.0.0",
        home,
        env: {},
        runtime: false,
        posthogKey: "phc_x",
        fetchImpl,
        log,
      });
      expect(log).toHaveBeenCalledOnce();
      await t.track("init_started", { framework: "next" });
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
