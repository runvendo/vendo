import { resolve } from "node:path";
import type { Telemetry } from "@vendoai/telemetry";
import { cloudDoctor, type CloudDoctorResult } from "./cloud/client.js";
import { checkConfigFiles, checkEjectDrift, checkModelResolution, checkMountAgreement, checkStorePersistence, checkSurfaceOwnership, checkToolCatalog } from "./doctor-config-checks.js";
import { checkInstalledDeps } from "./doctor-deps-checks.js";
import { checkMcpArtifacts } from "./doctor-mcp-checks.js";
import { createDoctorRun, type DoctorRun } from "./doctor-report.js";
import { checkWiring } from "./doctor-wiring-checks.js";
import { CLI_VERSION, consoleOutput, toolingTelemetry, type Output } from "./shared.js";
import { readEnvFiles } from "./sync-flow.js";

export interface DoctorOptions {
  targetDir: string;
  output?: Output;
  /** Machine-readable single-object output (design §5). */
  json?: boolean;
  env?: Record<string, string | undefined>;
  telemetry?: {
    home?: string;
    env?: Record<string, string | undefined>;
    posthogKey?: string;
    fetchImpl?: typeof fetch;
  };
}

/** root rides in as the client's cwd: projectIdHash/packageManager and the
    .env.local cloud-key read attribute to the TARGET project, not the shell
    cwd. Seams in options.telemetry win. */
function telemetryFor(options: DoctorOptions, output: Output, root: string): Telemetry {
  return toolingTelemetry({ cwd: root, ...options.telemetry, log: (message) => output.log(message) });
}

/** VENDO_API_KEY local shape check + what Cloud unlocks (design §5-6). Key
    problems surface on the first real service call — no validate round-trip. */
async function checkCloudKey(run: DoctorRun): Promise<CloudDoctorResult> {
  const cloud = await cloudDoctor({ env: run.env });
  if (cloud.present && cloud.ok) {
    run.pass("cloud/key", "Vendo Cloud key present and well-formed");
  } else if (cloud.present) {
    run.warn("cloud/key", "E-CLOUD-001", `VENDO_API_KEY is set but not usable: ${cloud.error ?? "malformed"}`);
  } else {
    run.note(`Vendo Cloud (optional): no VENDO_API_KEY. A key unlocks ${cloud.unlocks.join("; ")}. Run \`vendo login\` to start.`);
  }
  return cloud;
}

/** 09-vendo §5 — what is on disk, and nothing else. Doctor starts no server,
 *  makes no HTTP request, and needs no running app: it grades the files, the
 *  wiring markers and the environment variables the install left behind.
 *
 *  An itinerary, and nothing else: every section is a module that takes the
 *  `DoctorRun` (doctor-report.ts) and appends to its checks array, so the ORDER
 *  doctor reports in — which is the whole user-visible contract of this command
 *  — reads top to bottom here instead of over 750 lines. */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const root = resolve(options.targetDir);
  const output = options.output ?? consoleOutput;
  const json = options.json === true;
  // The ONE env reader for the whole CLI (sync-flow.ts): doctor runs
  // standalone, so unlike the dev server it gets no framework dotenv loading —
  // without this, a VENDO_API_KEY sitting in `.env.local` is invisible to the
  // cloud and model-credential checks and users must export it by hand.
  const env = options.env ?? await readEnvFiles(root);
  const telemetry = telemetryFor(options, output, root);
  const run = createDoctorRun({ root, env, json, output });

  await checkWiring(run);
  await checkInstalledDeps(run);
  await checkConfigFiles(run);
  await checkStorePersistence(run);
  await checkMountAgreement(run);
  await checkSurfaceOwnership(run);
  await checkModelResolution(run);
  await checkToolCatalog(run);
  await checkEjectDrift(run);
  await checkMcpArtifacts(run);

  const cloud = await checkCloudKey(run);

  const { failures, warnings, checks } = run;
  const wired = failures === 0;
  await telemetry.track("doctor_run", { failures, warnings, wired });

  if (json) {
    output.log(JSON.stringify({
      vendo: "doctor",
      version: CLI_VERSION,
      wired,
      exit: wired ? 0 : 1,
      checks,
      cloud,
      summary: { failures, warnings },
    }, null, 2));
  }
  return wired ? 0 : 1;
}
