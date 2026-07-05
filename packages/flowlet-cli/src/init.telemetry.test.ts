import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "./init.js";

describe("init telemetry", () => {
  it("emits init_started and init_completed with counts", async () => {
    const home = mkdtempSync(join(tmpdir(), "flowlet-init-tele-"));
    const target = mkdtempSync(join(tmpdir(), "flowlet-init-target-"));
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    try {
      await runInit({
        targetDir: target,
        skipLlm: true,
        force: true,
        model: null,
        telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
      });
      const events = fetchImpl.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body).event);
      expect(events).toContain("init_started");
      expect(events).toContain("init_completed");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
