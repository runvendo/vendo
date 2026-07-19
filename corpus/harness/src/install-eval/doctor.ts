import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstallEvalFixture } from "./fixtures.js";
import type { DoctorOutcome } from "./score.js";

/**
 * The harness runs `vendo doctor --json` ITSELF at the end of every run
 * (spec 2026-07-19 §Testing) — the agent's own claim of green is never
 * trusted. Doctor runs through the CLI the agent installed into the fixture
 * (`node_modules/.bin/vendo`); a missing bin is itself a failing outcome
 * (`vendo-cli-missing`), because the playbook's first step is the install.
 * The fixture's dev server is booted around the check since doctor's live
 * probes need a reachable /status (in --json mode doctor never boots it).
 */

const CLI_MISSING_CODE = "vendo-cli-missing";
const SERVER_UNREACHABLE_CODE = "dev-server-unreachable";

async function pathExists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

interface DevServerHandle {
  stop(): Promise<void>;
}

async function waitForReadiness(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
      if (response.status < 500) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

function startDevServer(
  fixtureDir: string,
  fixture: InstallEvalFixture,
  logPath: string,
  env: NodeJS.ProcessEnv,
): DevServerHandle {
  const child = spawn(fixture.devServer.command, {
    cwd: fixtureDir,
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, ...fixture.devServer.env },
  });
  const chunks: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { chunks.push(chunk); });
  child.stderr.on("data", (chunk: string) => { chunks.push(chunk); });

  return {
    async stop() {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      await writeFile(logPath, chunks.join(""));
    },
  };
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

interface DoctorJsonReport {
  wired?: boolean;
  checks?: { id?: string; status?: string; error_code?: string }[];
}

/** Doctor prints exactly one JSON object on stdout in --json mode; tolerate
 * stray lines around it. */
export function parseDoctorJson(stdout: string): DoctorJsonReport | null {
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(stdout.slice(start)) as DoctorJsonReport;
  } catch {
    return null;
  }
}

export function doctorOutcomeFromReport(report: DoctorJsonReport | null, exitCode: number | null, raw: string): DoctorOutcome {
  if (report === null) {
    return { ran: true, green: false, failingCodes: ["doctor-json-unparseable"], detail: raw.slice(0, 300) };
  }
  const failingCodes = (report.checks ?? [])
    .filter((check) => check.status === "broken")
    .map((check) => check.error_code ?? check.id ?? "unknown");
  return {
    ran: true,
    green: exitCode === 0 && report.wired === true,
    failingCodes,
  };
}

export interface RunFixtureDoctorOptions {
  fixture: InstallEvalFixture;
  fixtureDir: string;
  logsDir: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export async function runFixtureDoctor(options: RunFixtureDoctorOptions): Promise<DoctorOutcome> {
  const env = { ...(options.env ?? process.env), VENDO_TELEMETRY_DISABLED: "1" };
  const fetchImpl = options.fetchImpl ?? fetch;
  await mkdir(options.logsDir, { recursive: true });

  // Resolve the CLI the way npx would: the .bin link when npm created one,
  // else the bin file inside the installed package (npm 11.16+ can skip the
  // .bin link when vendoai and @vendoai/vendo both declare the same bin).
  const binLink = path.join(options.fixtureDir, "node_modules", ".bin", "vendo");
  const packageBins = [
    path.join(options.fixtureDir, "node_modules", "@vendoai", "vendo", "bin", "vendo.mjs"),
    path.join(options.fixtureDir, "node_modules", "vendoai", "bin", "vendo.mjs"),
  ];
  let doctorCommand: { command: string; prefixArgs: string[] } | undefined;
  if (await pathExists(binLink)) {
    doctorCommand = { command: binLink, prefixArgs: [] };
  } else {
    for (const bin of packageBins) {
      if (await pathExists(bin)) {
        doctorCommand = { command: process.execPath, prefixArgs: [bin] };
        break;
      }
    }
  }
  if (!doctorCommand) {
    return {
      ran: false,
      green: false,
      failingCodes: [CLI_MISSING_CODE],
      detail: "no vendo CLI in the fixture's node_modules — the agent never completed the package install.",
    };
  }

  const server = startDevServer(options.fixtureDir, options.fixture, path.join(options.logsDir, "install-eval.dev-server.log"), env);
  try {
    const ready = await waitForReadiness(
      options.fixture.devServer.readinessUrl,
      options.fixture.devServer.readinessTimeoutMs ?? 120_000,
      fetchImpl,
    );
    if (!ready) {
      return {
        ran: false,
        green: false,
        failingCodes: [SERVER_UNREACHABLE_CODE],
        detail: `dev server never became ready at ${options.fixture.devServer.readinessUrl}`,
      };
    }
    const result = await runCommand(
      doctorCommand.command,
      [...doctorCommand.prefixArgs, "doctor", ".", "--json", "--url", options.fixture.doctorUrl],
      options.fixtureDir,
      env,
    );
    await writeFile(
      path.join(options.logsDir, "install-eval.doctor.json.log"),
      `$ vendo doctor . --json --url ${options.fixture.doctorUrl}\n${result.stdout}\n${result.stderr}`,
    );
    return doctorOutcomeFromReport(parseDoctorJson(result.stdout), result.code, result.stdout + result.stderr);
  } finally {
    await server.stop();
  }
}
