import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLiveDoctor } from "./doctor-live.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("runLiveDoctor", () => {
  it("spawns the built CLI against the live Express mount and records a passing check", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vendo-doctor-workspace-"));
    tempRoots.push(workspaceRoot);
    const appRoot = path.join(workspaceRoot, "corpus/.repos/express-host");
    const logsDir = path.join(workspaceRoot, "corpus/.repos/.logs/express-host");
    const calls: Array<{ command: string; args: readonly string[]; cwd: string; telemetry?: string }> = [];

    const result = await runLiveDoctor({
      workspaceRoot,
      appRoot,
      readinessUrl: "http://127.0.0.1:3210",
      logsDir,
      env: { VENDO_TELEMETRY_DISABLED: "0" },
      async spawnDoctor(command, args, options) {
        calls.push({ command, args, cwd: options.cwd, telemetry: options.env.VENDO_TELEMETRY_DISABLED });
        return { code: 0, signal: null, stdout: "doctor passed\n", stderr: "" };
      },
    });

    expect(calls).toEqual([{
      command: process.execPath,
      args: [
        path.join(workspaceRoot, "packages/vendo/bin/vendo.mjs"),
        "doctor",
        appRoot,
        "--url",
        "http://127.0.0.1:3210/api/vendo",
      ],
      cwd: workspaceRoot,
      telemetry: "1",
    }]);
    expect(result.check).toMatchObject({ id: "doctor.live", pass: true });
    await expect(readFile(result.logPath, "utf8")).resolves.toContain("doctor passed");
  });

  it("records nonzero and spawn failures as failed doctor.live checks", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vendo-doctor-failure-"));
    tempRoots.push(workspaceRoot);
    const shared = {
      workspaceRoot,
      appRoot: path.join(workspaceRoot, "app"),
      readinessUrl: "http://127.0.0.1:3210/",
      logsDir: path.join(workspaceRoot, "logs"),
    };

    const nonzero = await runLiveDoctor({
      ...shared,
      async spawnDoctor() {
        return { code: 2, signal: null, stdout: "", stderr: "wiring missing" };
      },
    });
    expect(nonzero.check).toMatchObject({ id: "doctor.live", pass: false });
    expect(nonzero.check.detail).toContain("exit code 2");

    const failedStart = await runLiveDoctor({
      ...shared,
      async spawnDoctor() {
        throw new Error("spawn ENOENT");
      },
    });
    expect(failedStart.check).toMatchObject({ id: "doctor.live", pass: false });
    expect(failedStart.check.detail).toContain("spawn ENOENT");
  });
});
