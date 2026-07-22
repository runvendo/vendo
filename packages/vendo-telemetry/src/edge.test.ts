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
});
