import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyMarkedDiff, deriveStarter } from "./marked-diff.js";
import { injectLocalVendo, packLocalVendo, type PackedVendo } from "./local-pack.js";

/** The Lane E full journey (spec: init as-is + scripted diff): derive the
 * fresh framework starter into a temp dir → install with the local Vendo pack
 * → run the CURRENT `vendo init --yes` for server wiring → apply the
 * example's marked BYO diff programmatically → boot the app → drive one live
 * turn to an actual app creation over the same wire the embeds use. */

export const workspaceRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const vendoCli = path.join(workspaceRoot, "packages/vendo/bin/vendo.mjs");

export interface JourneyOptions {
  /** examples/<name> to journey. */
  example: "ai-sdk-agent" | "mastra-agent";
  port: number;
  /** The live-turn prompt; must ask for generated UI. */
  prompt: string;
  /** Extra env for init + the dev server (model keys). */
  env: Record<string, string | undefined>;
  /** Where logs/evidence land (created if missing). */
  artifactsDir: string;
  packed: PackedVendo;
}

export interface JourneyResult {
  scaffoldDir: string;
  initExitCode: number;
  initWiredRoute: boolean;
  appliedFiles: string[];
  appId: string;
  appSurface: { kind: string };
  appSurfaceText: string;
}

interface CommandResult {
  code: number | null;
  output: string;
}

function runLogged(
  command: string,
  args: readonly string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; logFile: string },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      void fs.writeFile(opts.logFile, output).then(() => resolve({ code, output }), reject);
    });
  });
}

async function checked(step: string, promise: Promise<CommandResult>): Promise<CommandResult> {
  const result = await promise;
  if (result.code !== 0) {
    throw new Error(`${step} exited ${result.code}:\n${result.output.slice(-4000)}`);
  }
  return result;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(baseUrl: string, dev: ChildProcess, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (dev.exitCode !== null) throw new Error(`dev server exited early (${dev.exitCode})`);
    try {
      const response = await fetch(baseUrl, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(1_500);
  }
  throw new Error(`dev server did not become ready at ${baseUrl}`);
}

/** One shared pack per live run (module-level: the vitest file runs journeys
 * sequentially). */
let packedOnce: Promise<PackedVendo> | null = null;
export function packOnce(): Promise<PackedVendo> {
  packedOnce ??= (async () => {
    const dest = await fs.mkdtemp(path.join(tmpdir(), "vendo-journey-pack-"));
    return packLocalVendo(workspaceRoot, dest);
  })();
  return packedOnce;
}

/** Keys that would silently change the scaffold's posture (Cloud defaults,
 * sandbox venue, connections broker, other model rungs): the journey passes
 * exactly the credentials it means to (opts.env) and nothing else, so the
 * booted app's posture is the example's documented BYO posture. */
const POSTURE_ENV_KEYS = [
  "VENDO_API_KEY",
  "VENDO_CLOUD_URL",
  "E2B_API_KEY",
  "COMPOSIO_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "VENDO_STORE_ENCRYPTION_KEY",
] as const;

function scrubbedEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of POSTURE_ENV_KEYS) delete env[name];
  for (const name of Object.keys(env)) {
    // The vitest process runs under pnpm, which exports its own config as
    // npm_config_* (e.g. a minimum-release-age `before` date that rejects the
    // examples' fresh pins). The scaffold is a fresh user's app — it gets a
    // clean package-manager environment.
    if (name.toLowerCase().startsWith("npm_") || name === "NODE_ENV" || name === "PNPM_HOME") delete env[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export async function runJourney(opts: JourneyOptions): Promise<JourneyResult> {
  const exampleDir = path.join(workspaceRoot, "examples", opts.example);
  await fs.mkdir(opts.artifactsDir, { recursive: true });
  const scaffoldDir = await fs.mkdtemp(path.join(tmpdir(), `vendo-journey-${opts.example}-`));
  const log = (name: string): string => path.join(opts.artifactsDir, name);
  const keep = process.env.VENDO_JOURNEY_KEEP === "1";
  let dev: ChildProcess | null = null;

  try {
    // 1. The fresh framework starter, in a temp dir outside the workspace.
    const derivation = await deriveStarter(exampleDir, scaffoldDir);
    await fs.writeFile(log("starter.json"), `${JSON.stringify(derivation, null, 2)}\n`);
    await fs.writeFile(
      path.join(scaffoldDir, ".gitignore"),
      "node_modules/\n.next/\nvendor/\n.vendo/data/\n.env*\n*.db\n*.duckdb*\nmastra.db*\n",
    );

    // 2. Local Vendo injection + the host's own install.
    await injectLocalVendo(scaffoldDir, opts.packed);
    // --legacy-peer-deps: the Mastra starter's peer graph trips npm's strict
    // resolver (ERESOLVE on @mastra/core with file: overrides in play); the
    // versions the example pins are coherent, so skip the auto-peer pass.
    await checked("npm install", runLogged("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "--legacy-peer-deps"], {
      cwd: scaffoldDir,
      // min-release-age: the operator's ~/.npmrc quarantine window would
      // reject the examples' freshly published ai-train pins.
      env: scrubbedEnv({ npm_config_min_release_age: "0" }),
      logFile: log("install.log"),
    }));

    // 3. Git snapshot so init's changes are inspectable evidence.
    const git = (args: string[]) => checked(`git ${args[0]}`, runLogged("git", args, { cwd: scaffoldDir, logFile: log("git.log") }));
    await git(["init", "-q"]);
    await git(["add", "-A"]);
    await git(["-c", "user.email=journey@vendo.test", "-c", "user.name=journey", "commit", "-qm", "starter"]);

    // 4. The CURRENT `vendo init --yes` — unchanged, exactly as shipped.
    const initEnv = scrubbedEnv({
      ...opts.env,
      VENDO_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
    });
    const init = await checked(
      "vendo init",
      runLogged(process.execPath, [vendoCli, "init", scaffoldDir, "--yes"], {
        cwd: workspaceRoot,
        env: initEnv,
        logFile: log("init.log"),
      }),
    );
    const initWiredRoute = /\+\s+.*api\/vendo\/\[\.\.\.vendo\]\/route\.ts/.test(init.output);
    await checked("git add", runLogged("git", ["add", "-A"], { cwd: scaffoldDir, logFile: log("git.log") }));
    const initDiff = await checked("git diff", runLogged("git", ["diff", "--cached", "--stat", "HEAD"], { cwd: scaffoldDir, logFile: log("git.log") }));
    await fs.writeFile(log("init.diff.stat"), initDiff.output);

    // 5. The example's marked BYO diff, applied programmatically.
    const appliedFiles = await applyMarkedDiff(exampleDir, scaffoldDir);
    await fs.writeFile(log("applied.json"), `${JSON.stringify(appliedFiles, null, 2)}\n`);

    // 6. Boot. Straight through the next bin: `npm run dev` would fire init's
    // `predev: vendo sync` hook, which regenerates .vendo/tools.json from
    // static extraction and would drop the example's hand-written
    // server-action descriptors.
    const nextBin = path.join(scaffoldDir, "node_modules/next/dist/bin/next");
    const devLogStream = createWriteStream(log("dev.log"));
    dev = spawn(process.execPath, [nextBin, "dev", "--port", String(opts.port)], {
      cwd: scaffoldDir,
      env: scrubbedEnv({ ...opts.env, NEXT_TELEMETRY_DISABLED: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    dev.stdout!.on("data", (chunk) => devLogStream.write(chunk));
    dev.stderr!.on("data", (chunk) => devLogStream.write(chunk));
    dev.once("close", () => devLogStream.end());
    const baseUrl = `http://localhost:${opts.port}`;
    await waitForServer(baseUrl, dev, 4 * 60_000);

    // What a real page load does before any chat turn: <VendoProvider> hits
    // the wire, which readies the composition (store schema included) — the
    // guarded pack in the chat route relies on it, exactly like a browser
    // session would.
    const statusResponse = await fetch(`${baseUrl}/api/vendo/status`);
    await fs.writeFile(log("status.json"), await statusResponse.text());
    if (statusResponse.status !== 200) {
      throw new Error(`wire /status returned ${statusResponse.status}; see status.json`);
    }

    // 7+8. One live turn to an actual app creation, then the embed's
    // resolution path: the build streams over the wire; open() serves the
    // finished surface (404-polls during the build by design). Live
    // generation is a real model — pass@2, the corpus live-gate precedent.
    let appId: string | undefined;
    let appSurfaceText = "";
    let lastFailure = "";
    for (let attempt = 1; attempt <= 2 && appSurfaceText === ""; attempt += 1) {
      const suffix = attempt === 1 ? "" : `-${attempt}`;
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: `journey${suffix}`,
          messages: [{ id: `j${attempt}`, role: "user", parts: [{ type: "text", text: opts.prompt }] }],
        }),
      });
      const turnText = await response.text();
      await fs.writeFile(log(`turn${suffix}.log`), turnText);
      if (response.status !== 200) throw new Error(`live turn returned ${response.status}; see turn${suffix}.log`);
      const refAt = turnText.indexOf("vendo/app-ref@1");
      if (refAt < 0) throw new Error(`live turn produced no vendo/app-ref@1 envelope; see turn${suffix}.log`);
      appId = /app_[A-Za-z0-9-]+/.exec(turnText.slice(refAt))?.[0];
      if (appId === undefined) throw new Error(`app-ref envelope carried no app id; see turn${suffix}.log`);

      const openUrl = `${baseUrl}/api/vendo/apps/${appId}/open`;
      const recordUrl = `${baseUrl}/api/vendo/apps/${appId}`;
      const deadline = Date.now() + 5 * 60_000;
      let record = "";
      while (Date.now() < deadline) {
        const opened = await fetch(openUrl);
        if (opened.status === 200) {
          appSurfaceText = await opened.text();
          break;
        }
        // The app row lands when the streamed build settles: a 404 record
        // just means "still building". Stop early only on a real failed record.
        const recordResponse = await fetch(recordUrl).catch(() => null);
        if (recordResponse !== null) {
          record = await recordResponse.text();
          await fs.writeFile(log(`app-record${suffix}.json`), record);
          if (recordResponse.status === 200 && /"(failed|error)"/.test(record)) break;
        }
        await sleep(3_000);
      }
      if (appSurfaceText === "") {
        // The audit trail carries the build outcome the swallowed background
        // generation never surfaces to the loop.
        const activity = await fetch(`${baseUrl}/api/vendo/activity?limit=30`).then((r) => r.text()).catch(() => "");
        await fs.writeFile(log(`activity${suffix}.json`), activity);
        lastFailure = `attempt ${attempt}: app ${appId} never became servable; app record: ${record.slice(0, 500)}; recent activity: ${activity.slice(0, 2000)}`;
        console.warn(`[journey] ${lastFailure.slice(0, 300)}`);
      }
    }
    if (appId === undefined || appSurfaceText === "") {
      throw new Error(`generated app never became servable after 2 live attempts. ${lastFailure}`);
    }
    await fs.writeFile(log("app.json"), appSurfaceText);
    const appSurface = JSON.parse(appSurfaceText) as { kind: string };

    const result: JourneyResult = {
      scaffoldDir,
      initExitCode: init.code ?? -1,
      initWiredRoute,
      appliedFiles,
      appId,
      appSurface,
      appSurfaceText,
    };
    await fs.writeFile(log("journey.json"), `${JSON.stringify({ ...result, appSurfaceText: undefined }, null, 2)}\n`);
    return result;
  } finally {
    if (dev !== null && dev.exitCode === null) {
      dev.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => dev!.once("close", resolve)), sleep(10_000)]);
      if (dev.exitCode === null) dev.kill("SIGKILL");
    }
    if (keep) console.log(`VENDO_JOURNEY_KEEP=1 — scaffold retained at ${scaffoldDir}`);
    else await fs.rm(scaffoldDir, { recursive: true, force: true }).catch(() => {});
  }
}
