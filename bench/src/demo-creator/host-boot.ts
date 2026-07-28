import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { chromium } from "@playwright/test";
import { sendPrompt, VendoTurnError, VendoTurnTimeout, waitForTurn } from "../demo-capture/capture.js";
import { genManifestScript, hostDir } from "./demo-folder.js";
import { createScrubber, defaultExec, delay, scrubbingTransform, type ExecFn } from "./exec.js";
import { agentRunDoorProblem, classifySmoke, installSmokeObserverInPage, noProgress, readHostToolTraffic, smokeReadyMs, type SmokeOutcome } from "./smoke.js";

/**
 * Stage 4's plumbing: drive the vendo-demos HOST (a foreign checkout, not this
 * workspace) through gen-manifest → build → boot → one smoke turn.
 *
 * Every command is data ({@link defaultHostCommands}) so the host repo's own
 * README contract is honoured in ONE place — if lane 1's scripts are named
 * differently, that object is the only edit.
 */

export interface RunningHost {
  baseUrl: string;
  stop(): Promise<void>;
}

/** The commands that drive the vendo-demos host. One place, so lane 1's README
 *  contract can be honoured with a one-line change. */
export interface HostCommands {
  /** Run in <demosRepo>/host. */
  genManifest: string[];
  install: string[];
  build: string[];
  start: (port: number) => string[];
}

export const defaultHostCommands: HostCommands = {
  // Derived from the frozen script path so demo-folder.ts stays the single
  // source of truth for the host's layout.
  genManifest: ["node", path.relative(hostDir, genManifestScript)],
  install: ["pnpm", "install"],
  build: ["pnpm", "build"],
  start: (port: number) => ["pnpm", "start", "--port", String(port)],
};

const hostPath = (demosRepo: string): string => path.join(demosRepo, hostDir);

/** host/src/generated/manifest.ts — build-time codegen, per the contract. */
const manifestPath = (demosRepo: string): string =>
  path.join(hostPath(demosRepo), "src", "generated", "manifest.ts");

/**
 * Runs the host's build-time discovery script and reports which demos it
 * actually wired in.
 *
 * The slugs are read back out of the GENERATED manifest, not the script's
 * stdout: the manifest's static imports are what the host compiles, and the
 * contract freezes their shape (`demos/<slug>/...`), while the script's log
 * format is lane 1's to change.
 */
export async function generateManifest(options: {
  demosRepo: string;
  exec?: ExecFn;
  write?: (line: string) => void;
  commands?: HostCommands;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): Promise<{ manifestPath: string; slugs: string[] }> {
  const exec = options.exec ?? defaultExec;
  const commands = options.commands ?? defaultHostCommands;
  const scrub = createScrubber(options.env ?? process.env);
  const result = await exec(commands.genManifest, {
    cwd: hostPath(options.demosRepo),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  if (result.code !== 0) {
    // The TAIL of both streams, never the first line. The script prints a header
    // ("the demo folder contract is not honored:") and then the problems one per
    // line, so reporting the first line reported a failure with NO reason — and
    // Next-style causes land on stdout while stderr carries only warnings, so
    // picking one stream hides the cause about half the time. Bounded and
    // scrubbed for the same reasons buildHost's tail is.
    const output = `${result.stdout}${result.stderr}`.trim();
    throw new Error(`gen-manifest failed (exit ${result.code}):\n${scrub(output.slice(-3_000)) || "no output"}`);
  }
  const generated = manifestPath(options.demosRepo);
  const source = await readFile(generated, "utf8").catch(() => undefined);
  if (source === undefined) {
    throw new Error(`gen-manifest exited 0 but wrote no ${path.relative(options.demosRepo, generated)} — the host cannot discover any demo`);
  }
  const slugs = [...new Set([...source.matchAll(/demos\/([A-Za-z0-9][A-Za-z0-9._-]*)\//g)].map((match) => match[1] as string))];
  options.write?.(`[assemble] manifest lists ${slugs.length} demo(s): ${slugs.join(", ") || "none"}`);
  return { manifestPath: generated, slugs };
}

/** `next build` for the whole host. A non-zero exit is the contract's "a
 * failing demo NEVER gets pushed": it throws, and the tail of the output is
 * the only thing that tells an operator which generated file broke. */
export async function buildHost(options: {
  demosRepo: string;
  exec?: ExecFn;
  write?: (line: string) => void;
  commands?: HostCommands;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const exec = options.exec ?? defaultExec;
  const commands = options.commands ?? defaultHostCommands;
  options.write?.(`[assemble] building the host (${commands.build.join(" ")})`);
  const result = await exec(commands.build, {
    cwd: hostPath(options.demosRepo),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  if (result.code !== 0) {
    // Both streams: Next prints type errors on stdout and warnings on stderr,
    // so picking one stream hides the actual cause about half the time.
    const output = `${result.stdout}${result.stderr}`;
    // The build gets the pipeline's whole environment, and this tail is relayed
    // to a terminal and a Slack thread.
    const scrub = createScrubber(options.env ?? process.env);
    throw new Error(`host build failed (exit ${result.code}):\n${scrub(output.slice(-3_000))}`);
  }
}

async function tcpReady(url: string): Promise<boolean> {
  const parsed = new URL(url);
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: parsed.hostname, port });
    const finish = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(2_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** The `child.exitCode` check is the point: a host that dies on startup (port
 * taken, missing build output) must fail LOUDLY here instead of hanging until
 * the timeout with nothing to show for it. */
async function waitUntilReady(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vendo-demos host exited before ${url} became ready (code ${child.exitCode})`);
    if (await tcpReady(url)) return;
    await delay(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url}`);
}

/** An open port is not a served page: Next accepts connections before the
 * server is answering. Any status < 500 counts — the shared host's root has no
 * slug and legitimately 404s. */
async function waitUntilHttpReady(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vendo-demos host exited before ${url} served HTTP (code ${child.exitCode})`);
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(remaining) });
      if (response.status < 500) return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await delay(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for HTTP from ${url}`);
}

/** SIGTERM the whole process group, SIGKILL what survives 5s: `pnpm start`
 * spawns the actual server as a child, so signalling only the pnpm pid leaves
 * the port held by an orphan. */
async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5_000).then(() => {
      if (child.exitCode === null && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }),
  ]);
}

/** Where a local boot serves from, and therefore its only correct wire origin. */
const loopbackOrigin = (port: number): string => `http://127.0.0.1:${port}`;

/**
 * The env a LOCAL boot needs on top of the operator's.
 *
 * The host ships an auth wall (host middleware), so a smoke turn and the
 * judge's screenshots would otherwise land on `/login` and wait for a composer
 * that is not there — a live run burned its whole 180s smoke budget exactly
 * that way. `DEMO_AUTOLOGIN` is the deployment's own knob for this, and it is
 * authority-bound: the middleware only honours it for requests arriving on
 * `VENDO_BASE_URL`'s origin, which here is the loopback port this function just
 * started. So this is the deployed posture applied locally, not a loosened one.
 *
 * `DEMO_AUTOLOGIN` is the operator's to set. `VENDO_BASE_URL` is NOT, and that
 * asymmetry is the whole point of this function now: it is the WIRE ORIGIN, the
 * base every one of the demo's openapi tool bindings is resolved against
 * (`@vendoai/vendo` reads it from the environment and hands it to
 * `@vendoai/actions`). On 2026-07-28 it was briefly set to a hostname that still
 * resolved to the old router, and every tool call on every demo left the host and
 * 404'd elsewhere — while every page still rendered perfectly, so nothing
 * page-level noticed. The cutover runbook tells operators to export exactly that
 * variable, so inheriting it here would have pointed the smoke turn's tool calls
 * at a completely different host and called whatever came back evidence.
 *
 * A server on 127.0.0.1 has exactly one correct wire origin: itself. So this is
 * made true by construction rather than checked, and {@link inheritedWireOrigin}
 * is what lets the caller say out loud that it had to be.
 */
export function localBootEnv(env: NodeJS.ProcessEnv, port: number): NodeJS.ProcessEnv {
  return {
    ...env,
    DEMO_AUTOLOGIN: env.DEMO_AUTOLOGIN ?? "1",
    VENDO_BASE_URL: loopbackOrigin(port),
  };
}

/**
 * The wire origin the environment was carrying, when it is not the host about to
 * be booted — the one thing worth SAYING before a local boot silently corrects
 * it, because it is the shape of a fault that killed every tool call on the whole
 * fleet without touching a single page.
 */
export function inheritedWireOrigin(env: NodeJS.ProcessEnv, port: number): string | undefined {
  const configured = env.VENDO_BASE_URL;
  if (configured === undefined || configured === "") return undefined;
  // A trailing slash is the same origin; the host normalises it too.
  if (configured.replace(/\/$/, "") === loopbackOrigin(port)) return undefined;
  return configured;
}

/** Boots the built host from its own directory (no workspace filter: the
 * vendo-demos checkout is foreign to this repo) and waits until it serves
 * HTTP. Stops itself if readiness fails, so a half-started host never leaks. */
export async function bootHost(options: {
  demosRepo: string;
  port: number;
  logFile: string;
  timeoutMs: number;
  commands?: HostCommands;
  env?: NodeJS.ProcessEnv;
}): Promise<RunningHost> {
  const commands = options.commands ?? defaultHostCommands;
  const [file, ...argv] = commands.start(options.port);
  if (file === undefined) throw new Error("host start command is empty");
  await mkdir(path.dirname(options.logFile), { recursive: true });
  const log = createWriteStream(options.logFile, { flags: "a" });
  const bootEnv = localBootEnv(options.env ?? process.env, options.port);
  const child = spawn(file, argv, {
    cwd: hostPath(options.demosRepo),
    env: bootEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // The child carries the operator's WHOLE environment (it is the demo host, and
  // it needs VENDO_API_KEY), and a Next crash echoes the environment — so nothing
  // reaches this log file unscrubbed.
  const scrubLog = createScrubber(bootEnv);
  child.stdout?.pipe(scrubbingTransform(scrubLog)).pipe(log);
  child.stderr?.pipe(scrubbingTransform(scrubLog)).pipe(log);
  const baseUrl = `http://127.0.0.1:${options.port}`;
  try {
    await waitUntilReady(baseUrl, child, options.timeoutMs);
    await waitUntilHttpReady(baseUrl, child, options.timeoutMs);
  } catch (error) {
    await stopProcess(child);
    log.end();
    throw error;
  }
  let stopped = false;
  return {
    baseUrl,
    async stop() {
      if (stopped) return;
      stopped = true;
      await stopProcess(child);
      log.end();
    },
  };
}

export type SmokeTurnFn = (options: {
  baseUrl: string;
  slug: string;
  prompt: string;
  timeoutMs: number;
  /** The names of the tools that execute against the DEMO'S OWN API — the only
   *  ones whose success proves this demo can answer anything. */
  hostToolNames: readonly string[];
}) => Promise<SmokeOutcome>;

/**
 * How long to wait for the turn's response body after the turn itself is over.
 *
 * The body is an SSE stream that stays open for the whole turn, so by the time
 * this is awaited it is almost always complete — EXCEPT on a deadline, where the
 * turn is still streaming and this would otherwise wait forever. On that path the
 * verdict is already decided, so a short bound costs nothing.
 */
const turnStreamDrainMs = 5_000;

/** `requireView: false` is the contract's "gates on HARD error only": the smoke
 * turn passes as long as the turn did not error and did settle. What the agent
 * generated is the judge's business, never stage 4's. Split out so that rule is
 * pinned by a test instead of by a browser run. */
export function smokeTurnWaitOptions(options: { previousAssistantTurns: number; timeoutMs: number }): {
  previousAssistantTurns: number;
  timeoutMs: number;
  requireView: false;
} {
  return { previousAssistantTurns: options.previousAssistantTurns, timeoutMs: options.timeoutMs, requireView: false };
}

/**
 * Drives /<slug>/vendo in a real browser and REPORTS what happened rather than
 * throwing: whether the demo's agent is broken or merely slow is a judgement
 * (see {@link classifySmoke}), and a thrown Error cannot carry the evidence that
 * judgement needs.
 *
 * Four things are watched at once. The DOOR — the demo's own
 * `/api/vendo/<slug>/…` route — is watched at the wire, because a 500 there is
 * the dead-agent shape (no model provider, a tools file the runtime cannot parse)
 * and it arrives within seconds. The in-page observer records the two signs of
 * life. The turn wait supplies settled, errored, or out of clock. And the turn's
 * own RESPONSE BODY is read back, because it is the only place that says whether
 * the demo's API answered its agent: the transcript renders nothing for a settled
 * tool call, and a FAILED call is not a stream error either — the runtime hands
 * the failure to the model as the tool's output. Reading the body rather than
 * intercepting the request keeps the stream streaming, so nothing about the turn's
 * timing or its in-page liveness signals changes.
 */
export const defaultSmokeTurn: SmokeTurnFn = async (options) => {
  const browser = await chromium.launch();
  const progress = noProgress();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    // Only the request that RUNS the turn counts — see agentRunDoorProblem for
    // why "any non-2xx under /api/vendo/<slug>" would fail healthy demos.
    const agentRunDoor = `/api/vendo/${options.slug}/threads`;
    /** The turn's own response bodies, read back after it ends. */
    const turnStreams: Promise<string>[] = [];
    page.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      const method = response.request().method();
      if (method.toUpperCase() === "POST" && pathname === agentRunDoor) {
        progress.doorAnswered = true;
        turnStreams.push(response.text().catch(() => ""));
      }
      const problem = agentRunDoorProblem({ slug: options.slug, method, pathname, status: response.status() });
      if (problem !== undefined && progress.doorError === undefined) progress.doorError = problem;
    });
    page.on("requestfailed", (request) => {
      const problem = agentRunDoorProblem({
        slug: options.slug,
        method: request.method(),
        pathname: new URL(request.url()).pathname,
        ...(request.failure() === null ? {} : { failure: request.failure()?.errorText ?? "request failed" }),
      });
      if (problem !== undefined && progress.doorError === undefined) progress.doorError = problem;
    });
    // GETTING TO A PROMPT is its own phase, on its own short budget. A demo whose
    // page never renders a composer is broken NOW, and charging that wait against
    // the turn budget is how a dead demo took the full 420s to fail and then threw
    // a raw Playwright error instead of a verdict.
    let sent: { assistantTurns: number };
    try {
      await page.goto(new URL(`/${options.slug}/vendo`, options.baseUrl).toString(), {
        waitUntil: "domcontentloaded",
        timeout: smokeReadyMs,
      });
      await page.getByRole("textbox", { name: "Message" }).waitFor({ state: "visible", timeout: smokeReadyMs });
      // Installed BEFORE the prompt is sent: the observer's baseline is "the turns
      // already on this page", so a demo:fix re-smoke cannot mistake an old turn
      // for this one's stream.
      await page.evaluate(installSmokeObserverInPage);
      sent = await sendPrompt(page, options.prompt);
    } catch (error) {
      return classifySmoke({
        settled: false,
        timedOut: false,
        pageUnusable: error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error),
        progress,
      });
    }
    let settled = false;
    let surfacedError: string | undefined;
    let timedOut = false;
    try {
      await waitForTurn({
        page,
        ...smokeTurnWaitOptions({ previousAssistantTurns: sent.assistantTurns, timeoutMs: options.timeoutMs }),
      });
      settled = true;
    } catch (error) {
      if (error instanceof VendoTurnError) surfacedError = error.surfaced;
      else if (error instanceof VendoTurnTimeout) timedOut = true;
      // Anything else is the harness failing, not a verdict about the demo.
      else throw error;
    }
    const observed = await page.evaluate(() => window.__vendoSmoke?.snapshot())
      ?? { turnStarted: false, toolCall: false };
    progress.turnStarted = observed.turnStarted;
    progress.toolCall = observed.toolCall;
    // Bounded: on a deadline the stream is still open, and the verdict is already
    // decided, so waiting the rest of the turn out would buy nothing.
    const streamed = await Promise.race([
      Promise.all(turnStreams).then((bodies) => bodies.join("\n")),
      delay(turnStreamDrainMs).then(() => ""),
    ]);
    const traffic = readHostToolTraffic(streamed, options.hostToolNames);
    progress.hostToolAnswered = traffic.answered;
    if (traffic.problem !== undefined) progress.hostToolProblem = traffic.problem;
    return classifySmoke({
      settled,
      timedOut,
      progress,
      ...(surfacedError === undefined ? {} : { surfacedError }),
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
};
