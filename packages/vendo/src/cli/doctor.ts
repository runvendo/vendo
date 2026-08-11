import { resolve } from "node:path";
import type { Telemetry } from "@vendoai/telemetry";
import {
  cloudDoctor,
  liveModelTurn,
  type CloudDoctorResult,
  type LiveTurnResult,
} from "./doctor-live.js";
import { checkConfigFiles, checkEjectDrift, checkModelResolution, checkMountAgreement, checkSurfaceOwnership, checkToolCatalog } from "./doctor-config-checks.js";
import { checkInstalledDeps } from "./doctor-deps-checks.js";
import { checkMcpDiscovery } from "./doctor-mcp-checks.js";
import { checkAuthProbes, checkLiveStatus, checkRootRender, reportMachines, startDevServerIfOffered } from "./doctor-probe-checks.js";
import { createDoctorRun, type DoctorRun } from "./doctor-report.js";
import { checkWiring } from "./doctor-wiring-checks.js";
import { CLI_VERSION, consoleOutput, toolingTelemetry, type Output } from "./shared.js";
import { readEnvFiles } from "./sync-flow.js";

export interface DoctorOptions {
  targetDir: string;
  url?: string;
  fetchImpl?: typeof fetch;
  output?: Output;
  /** Machine-readable single-object output (design §5). */
  json?: boolean;
  /** Auto-confirm the dev-server-probe consent — works non-interactively
   *  (piped stdio / CI); --json runs never start the server. */
  yes?: boolean;
  env?: Record<string, string | undefined>;
  telemetry?: {
    home?: string;
    env?: Record<string, string | undefined>;
    posthogKey?: string;
    fetchImpl?: typeof fetch;
  };
  /** Seams (tests): each new probe is injectable so doctor runs without keys
   *  or a running server. */
  interactive?: boolean;
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  liveTurn?: (base: string) => Promise<LiveTurnResult>;
  cloudProbe?: (options: { env?: Record<string, string | undefined> }) => Promise<CloudDoctorResult>;
  startDevServer?: (options: { root: string; statusUrl: string; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }) => Promise<{ ok: boolean; stop: () => void }>;
  /** The npm `latest` lookup behind the version-skew line — its own seam, not
      fetchImpl, so a scripted wire probe never doubles as a registry answer. */
  npmLatest?: () => Promise<string | null>;
}

/** root rides in as the client's cwd: projectIdHash/packageManager and the
    .env.local cloud-key read attribute to the TARGET project, not the shell
    cwd. Seams in options.telemetry win. */
function telemetryFor(options: DoctorOptions, output: Output, root: string): Telemetry {
  return toolingTelemetry({ cwd: root, ...options.telemetry, log: (message) => output.log(message) });
}

/** One real model turn through the wired route (design §5). Exit 0 == a user
    would have gotten an answer. Reuses the resolver + vendoModel: the running
    dev server serves the turn over the same credential doctor reports. */
async function checkLiveTurn(run: DoctorRun, options: DoctorOptions, liveComposition: boolean): Promise<LiveTurnResult> {
  const { statusUrl, fetchImpl, env } = run;
  if (!liveComposition) {
    run.fail("turn/model", "E-TURN-002", `live model turn cannot run; start the dev server at ${statusUrl} and retry`);
    return { attempted: false, ok: false, rung: "none", credential: "n/a", elapsedMs: 0, error: "dev server unreachable" };
  }
  const liveTurn = await (options.liveTurn ?? ((base: string) => liveModelTurn({
    base,
    fetchImpl,
    env,
  })))(statusUrl);
  if (liveTurn.ok) {
    run.pass("turn/model", `live model turn answered over ${liveTurn.credential} (${liveTurn.elapsedMs}ms)`);
    if (liveTurn.reply !== undefined) run.note(`\n  ${liveTurn.reply.trim()}\n`);
  } else {
    run.fail("turn/model", "E-TURN-001", `live model turn did not answer over ${liveTurn.credential}: ${liveTurn.error ?? "no reply"}`);
  }
  return liveTurn;
}

/** VENDO_API_KEY local shape check + what Cloud unlocks (design §5-6). Key
    problems surface on the first real service call — no validate round-trip. */
async function checkCloudKey(run: DoctorRun, options: DoctorOptions): Promise<CloudDoctorResult> {
  const cloud = await (options.cloudProbe ?? cloudDoctor)({ env: run.env });
  if (cloud.present && cloud.ok) {
    run.pass("cloud/key", "Vendo Cloud key present and well-formed");
  } else if (cloud.present) {
    run.warn("cloud/key", "E-CLOUD-001", `VENDO_API_KEY is set but not usable: ${cloud.error ?? "malformed"}`);
  } else {
    run.note(`Vendo Cloud (optional): no VENDO_API_KEY. A key unlocks ${cloud.unlocks.join("; ")}. Run \`vendo login\` to start.`);
  }
  return cloud;
}

/** 09-vendo §5 / block-actions A — wiring checks plus live composition,
    present-credential, and actAs mint+verify round-trips.
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
  // cloud and live-turn checks and users must export it by hand.
  const env = options.env ?? await readEnvFiles(root);
  const telemetry = telemetryFor(options, output, root);
  const run = createDoctorRun({
    root,
    env,
    json,
    statusUrl: options.url
      ?? env.VENDO_URL?.replace(/\/$/, "")
      ?? "http://localhost:3000/api/vendo",
    fetchImpl: options.fetchImpl ?? fetch,
    output,
  });

  await checkWiring(run);
  await checkInstalledDeps(run, output, options.npmLatest);
  await checkConfigFiles(run);
  await checkMountAgreement(run);
  await checkSurfaceOwnership(run);
  await checkModelResolution(run);
  await checkToolCatalog(run);
  await checkEjectDrift(run);

  const devServerStop = await startDevServerIfOffered(run, options);
  const { mcpPosture, live } = await checkLiveStatus(run);
  if (live) await checkRootRender(run);
  await checkAuthProbes(run, live);
  if (mcpPosture !== false) await checkMcpDiscovery(run, mcpPosture);
  if (live) await reportMachines(run);

  run.note("Ladder: execution venue is checked above; actAs for away host actions; connectors for external tools.");

  const liveTurn = await checkLiveTurn(run, options, live);
  const cloud = await checkCloudKey(run, options);

  if (devServerStop !== null) devServerStop();

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
      liveTurn,
      cloud,
      summary: { failures, warnings },
    }, null, 2));
  }
  return wired ? 0 : 1;
}
