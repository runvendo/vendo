import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scriptedModel, startTestHost, textTurn } from "./harness.js";

const hostDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const cli = fileURLToPath(new URL("../../../../packages/vendo/bin/vendo.mjs", import.meta.url));

function runDoctor(url: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "doctor", hostDir, "--url", `${url}/api/vendo`], {
      cwd: repoRoot,
      env: { ...process.env, VENDO_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}

describe("vendo doctor on the Express host", () => {
  // Express discovery lands in a parallel lane; this pins its expected behavior.
  it("recognizes the committed wiring and completes a live status probe", async () => {
    const host = await startTestHost(scriptedModel([textTurn("unused")]), { trustedOrigin: true });
    try {
      const result = await runDoctor(host.baseUrl);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("/status live round-trip");
    } finally {
      await host.close();
    }
  });
});
