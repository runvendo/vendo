import { describe, expect, it } from "vitest";

import { initTelemetry } from "../src/edge.js";

describe("edge telemetry entry", () => {
  it("returns a no-op client without touching disk, process, or node builtins", async () => {
    const telemetry = initTelemetry({ version: "0.0.0-test", runtime: true });
    await expect(telemetry.track("doctor_run", { ok: true })).resolves.toBeUndefined();
  });

  it("keeps the module free of node builtin imports", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../src/edge.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "node:/);
    expect(source).not.toMatch(/require\(/);
  });

  it("reads as opted out with nothing persisted (no disk on the edge)", async () => {
    const { loadConfig } = await import("../src/edge.js");
    expect(loadConfig()).toEqual({ anonymousId: "", optedOut: true, noticeShown: true });
  });

  it("reports no git remote host (deployed bundles have no working copy)", async () => {
    const { repoHost } = await import("../src/edge.js");
    expect(repoHost()).toBeUndefined();
    expect(repoHost("/srv/app")).toBeUndefined();
  });

  it("shares the pure consent module with the Node build", async () => {
    const edge = await import("../src/edge.js");
    const node = await import("../src/consent.js");
    expect(edge.envOptOut).toBe(node.envOptOut);
  });
});
