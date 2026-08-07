import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScorecardCheck } from "./scorecard.js";

export interface LiveDoctorCommandResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export type LiveDoctorSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<LiveDoctorCommandResult>;

export interface RunLiveDoctorOptions {
  workspaceRoot: string;
  appRoot: string;
  readinessUrl: string;
  logsDir: string;
  env?: NodeJS.ProcessEnv;
  spawnDoctor?: LiveDoctorSpawner;
}

export interface LiveDoctorResult {
  check: ScorecardCheck;
  logPath: string;
}

function defaultSpawnDoctor(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<LiveDoctorCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function commandStatus(result: LiveDoctorCommandResult): string {
  return result.code === null ? `signal ${result.signal ?? "unknown"}` : `exit code ${result.code}`;
}

function compactOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}...`;
}

export async function runLiveDoctor(options: RunLiveDoctorOptions): Promise<LiveDoctorResult> {
  const cliPath = path.join(options.workspaceRoot, "packages/vendo/bin/vendo.mjs");
  const liveUrl = new URL("/api/vendo", options.readinessUrl).toString();
  const args = [cliPath, "doctor", options.appRoot, "--url", liveUrl];
  const logPath = path.join(options.logsDir, "doctor.live.log");
  await mkdir(options.logsDir, { recursive: true });

  try {
    const result = await (options.spawnDoctor ?? defaultSpawnDoctor)(process.execPath, args, {
      cwd: options.workspaceRoot,
      env: {
        ...process.env,
        ...options.env,
        VENDO_TELEMETRY_DISABLED: "1",
      },
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    await writeFile(logPath, `$ ${process.execPath} ${args.join(" ")}\n${output}`);
    const pass = result.code === 0;
    return {
      check: {
        id: "doctor.live",
        pass,
        detail: pass
          ? `vendo doctor passed against ${liveUrl}`
          : `vendo doctor failed with ${commandStatus(result)} against ${liveUrl}${output ? `: ${compactOutput(output)}` : ""}`,
      },
      logPath,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await writeFile(logPath, `$ ${process.execPath} ${args.join(" ")}\n${detail}\n`);
    return {
      check: {
        id: "doctor.live",
        pass: false,
        detail: `vendo doctor failed to start against ${liveUrl}: ${detail}`,
      },
      logPath,
    };
  }
}
