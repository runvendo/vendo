import { describe, expect, it } from "vitest";

import { initTelemetry } from "./edge.js";

describe("edge telemetry entry", () => {
  it("returns a no-op client without touching disk, process, or node builtins", async () => {
    const telemetry = initTelemetry({ version: "0.0.0-test", runtime: true });
    await expect(telemetry.track("doctor_run", { ok: true })).resolves.toBeUndefined();
  });

  it("keeps the module free of node builtin imports", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./edge.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "node:/);
    expect(source).not.toMatch(/require\(/);
  });

  it("reads as opted out with nothing persisted (no disk on the edge)", async () => {
    const { loadConfig, saveConfig } = await import("./edge.js");
    const config = loadConfig();
    expect(config).toEqual({ anonymousId: "", optedOut: true, noticeShown: true });
    // No disk: saving is a no-op and the next read stays opted out.
    saveConfig("/nowhere", { anonymousId: "x", optedOut: false, noticeShown: false });
    expect(loadConfig()).toEqual(config);
  });

  it("reports no git remote host (deployed bundles have no working copy)", async () => {
    const { repoHost } = await import("./edge.js");
    expect(repoHost()).toBeUndefined();
    expect(repoHost("/srv/app")).toBeUndefined();
  });

  it("shares the pure consent module with the Node build", async () => {
    const edge = await import("./edge.js");
    const node = await import("./consent.js");
    expect(edge.envOptOut).toBe(node.envOptOut);
    expect(edge.resolveConsent).toBe(node.resolveConsent);
  });
});
