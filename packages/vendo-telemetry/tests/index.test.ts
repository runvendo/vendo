import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envOptOut } from "../src/consent.js";
import { initTelemetry } from "../src/index.js";

function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "vendo-tele-idx-"));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("initTelemetry", () => {
  it("wires config + notice + client and can track", async () => {
    const home = mkdtempSync(join(tmpdir(), "vendo-tele-idx-"));
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

describe("first-run notice", () => {
  it("advertises only opt-outs this package actually honors", () => {
    withHome((home) => {
      const log = vi.fn();
      initTelemetry({ version: "0.0.0", home, env: {}, log });
      const notice = log.mock.calls[0]![0] as string;

      const named = [...notice.matchAll(/\b([A-Z][A-Z_]+)=1\b/g)].map(([, name]) => name!);
      expect(named.length).toBeGreaterThan(0);
      for (const name of named) expect(envOptOut({ [name]: "1" })).toBe(true);

      // This package deliberately depends on no @vendoai package, so it can never
      // check that a `vendo …` command exists. Naming one is how the notice came
      // to advertise `vendo telemetry disable`, which the CLI has never had.
      expect(notice).not.toMatch(/`vendo /);
    });
  });

  it("prints once, persists noticeShown, and stays silent on the next run", () => {
    withHome((home) => {
      const first = vi.fn();
      initTelemetry({ version: "0.0.0", home, env: {}, log: first });
      expect(first).toHaveBeenCalledOnce();
      expect(first.mock.calls[0]![0]).toContain("TELEMETRY.md");

      const second = vi.fn();
      initTelemetry({ version: "0.0.0", home, env: {}, log: second });
      expect(second).not.toHaveBeenCalled();
    });
  });

  it("does nothing when opted out", () => {
    withHome((home) => {
      mkdirSync(join(home, ".vendo"), { recursive: true });
      writeFileSync(
        join(home, ".vendo", "telemetry.json"),
        JSON.stringify({ anonymousId: "x", optedOut: true, noticeShown: false }),
        "utf8",
      );
      const log = vi.fn();
      initTelemetry({ version: "0.0.0", home, env: {}, log });
      expect(log).not.toHaveBeenCalled();
    });
  });
});
