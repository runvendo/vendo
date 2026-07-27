import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { browserOpenCommand } from "./playground.js";
import { consoleOutput, withCommandRun, type Output, type TelemetryOptions } from "./shared.js";
import { readAppName, runDeepening, type DeepeningSummary, type RunDeepeningOptions } from "./try/deepen.js";
import { runDeterministicPass } from "./try/extract.js";
import { startTryServer, type TryServer } from "./try/server.js";

/**
 * `vendo try` — the unified try surface's front door (Task 7): profile the
 * cwd read-only (Task 2), serve the live local demo (Task 5), and deepen in
 * the background (Task 6). Zero commitment end to end: nothing is written to
 * the repo, no key is required, and Ctrl+C leaves no trace — the temp profile
 * root is swept on shutdown.
 *
 * The LATENCY LAW, enforced here at the call site: deepening starts strictly
 * AFTER the server is listening and is never awaited before serving —
 * runDeepening resolves for every failure by contract, so nothing gates on
 * it. Shutdown is the ONE place the captured promise is awaited (after the
 * server closes, before the sweep), so the sweep is the guaranteed last
 * writer of the profile root: a Ctrl+C mid-deepening cannot have the still-
 * live orchestrator write the swept directory back. A repo where the
 * deterministic pass finds nothing still serves: the surface paints a
 * shallow, generic-data profile instead of erroring.
 */

export interface TryOptions {
  /** The host repo to profile; defaults to the process cwd. Never written to. */
  repoRoot?: string;
  port?: number;
  /** When false (`--no-open`), print the URL without launching the browser. */
  open?: boolean;
  /** When false (`--no-ai`), skip background deepening entirely. */
  ai?: boolean;
  /** Pin the deepening engine family (`--engine`, validated by the CLI); an
   *  unavailable pin self-skips inside runDeepening — never a fallback. */
  engine?: string;
  output?: Output;
  /** Test seams. */
  env?: Record<string, string | undefined>;
  openBrowser?: (url: string) => void;
  /** Replaces the block-until-Ctrl+C wait: `false` shuts down right after
   *  startup; a function is awaited while the server is up (playground's wait
   *  seam, widened so tests can probe the live server and the profile root). */
  wait?: false | ((context: { url: string; profileRoot: string }) => Promise<void>);
  /** The deepening orchestrator (default runDeepening). */
  deepen?: (options: RunDeepeningOptions) => Promise<DeepeningSummary>;
  /** Injectable telemetry deps (matches init/doctor). */
  telemetry?: TelemetryOptions;
}

function defaultOpenBrowser(url: string): void {
  const { command, args } = browserOpenCommand(process.platform, url);
  execFile(command, args, () => undefined);
}

export async function runTry(options: TryOptions = {}): Promise<number> {
  const output = options.output ?? consoleOutput;
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  return withCommandRun(
    {
      command: "try",
      root: repoRoot,
      ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    },
    (failure) => tryCommand(options, repoRoot, output, failure),
  );
}

async function tryCommand(
  options: TryOptions,
  repoRoot: string,
  output: Output,
  failure: { failedStep?: string },
): Promise<number> {
  const env = options.env ?? process.env;

  output.log("Profiling your app (read-only — nothing in your repo is touched)…");
  const pass = await runDeterministicPass({ repoRoot });
  const { profileRoot } = pass;
  // The temp profile root is caller-owned (extract.ts's contract): every exit
  // below sweeps it, best-effort.
  const sweep = (): Promise<void> => rm(profileRoot, { recursive: true, force: true }).catch(() => undefined);
  if (pass.tools.count === 0 && pass.theme.slotsMatched === 0) {
    output.log("Nothing extractable detected — the demo runs on generic data.");
  } else {
    output.log(`Learned: ${pass.tools.count} tool${pass.tools.count === 1 ? "" : "s"} · theme ${pass.theme.slotsMatched > 0 ? "captured" : "defaults"}`);
  }

  let server: TryServer;
  try {
    server = await startTryServer({
      profileRoot,
      repoRoot,
      brand: { name: await readAppName(repoRoot) },
      env,
      ...(options.port === undefined ? {} : { port: options.port }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    failure.failedStep = "listen";
    output.error(`vendo try: could not listen on port ${options.port ?? 0} (${detail}) — pass a different --port`);
    await sweep();
    return 1;
  }

  let deepening: Promise<DeepeningSummary> | undefined;
  let deepeningPending = false;
  try {
    output.log(`Vendo try running at ${server.url}`);
    output.log("Your product's agent on extracted data. Press Ctrl+C to stop.");
    if (options.open !== false) (options.openBrowser ?? defaultOpenBrowser)(server.url);

    // Started only now that the server is up, and never awaited before
    // serving (the latency law) — the promise is captured for shutdown alone.
    if (options.ai !== false) {
      deepeningPending = true;
      deepening = (options.deepen ?? runDeepening)({
        repoRoot,
        profileRoot,
        events: server.events,
        env,
        output,
        ...(options.engine === undefined ? {} : { engine: options.engine }),
      });
      const settle = (): void => {
        deepeningPending = false;
      };
      void deepening.then(settle, settle);
    }

    if (typeof options.wait === "function") await options.wait({ url: server.url, profileRoot });
    else if (options.wait !== false) await new Promise<void>((resolveWait) => process.once("SIGINT", resolveWait));
  } finally {
    await server.close();
    // Let a mid-flight deepening settle before sweeping, so the sweep is the
    // LAST writer of profileRoot — otherwise its still-live writes would put
    // the swept directory right back. No added Ctrl+C latency versus not
    // waiting: the dropped promise's work kept running until now anyway.
    if (deepeningPending) output.log("Finishing background extraction before cleanup…");
    await deepening?.catch(() => undefined);
    await sweep();
  }

  output.log("Liked it? `npx vendo init` installs this agent in your app for keeps.");
  return 0;
}
