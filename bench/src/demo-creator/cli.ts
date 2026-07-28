#!/usr/bin/env node
import { parseDemoFixArgs, runDemoFix } from "./fix.js";
import { parseDemoPipelineArgs, preflight, runDemoPipeline } from "./pipeline.js";

/**
 * The demo-creator's whole operator surface: build a demo, or fix one. Both
 * commands print machine-readable outcome lines the Slack driver reads:
 * `SCORES: ...` and either `LIVE: <url>` (exit 0) or `FAILED: <cause>`.
 */

/** Exported so a test can hold it against {@link preflight}: `--help` and the
 * credential check disagreeing is how lane 3 provisioned a mini that
 * demo:pipeline then refused to start on. */
export function usage(): string {
  return `Usage:
  pnpm --filter @vendoai/bench demo:pipeline -- --id SLUG --prospect NAME --screenshots /abs/a.png,/abs/b.png [--url https://prospect-site] [--cta-url URL] [--expires 2026-08-31] [--notes notes.md] [--demos-repo /abs/path] [--skip-ship]
  pnpm --filter @vendoai/bench demo:fix -- --id SLUG --instruction "<free text>" [--demos-repo /abs/path] [--skip-ship]

demo:pipeline turns the prospect's real product screenshots into a live demo at
https://demos.vendo.run/SLUG, in one command: brand evidence (context.dev) →
one vision brand-brief → three parallel build agents → host build + a smoke
turn → fidelity judge → commit, push and deploy the shared host.
The demo itself is a folder in the vendo-demos host repo (--demos-repo, default
~/.vendo/vendo-demos, cloned/pulled automatically) — prospect branding lives
there and never in this repo.

demo:fix applies free-text operator feedback to an existing demo with ONE agent,
then re-assembles, re-judges and re-ships it.

Needs: ANTHROPIC_API_KEY (the creator harness — brief, judge and the claude CLI
agents all ride a provider key), CONTEXT_DEV_API_KEY (brand evidence),
VENDO_API_KEY (the host this pipeline BOOTS locally to smoke and screenshot the
demo runs the Cloud posture: its store, connections and agent route are
Cloud-composed, and the harness key does not stand in for it), the \`claude\` CLI
on PATH, and a logged-in \`railway\` CLI. None is ever logged.`;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  // The command positional comes from the package.json script itself
  // (demo:pipeline / demo:fix); everything after it is user arguments.
  const [command, ...rest] = process.argv.slice(2);
  if (command === "pipeline") {
    const args = parseDemoPipelineArgs(rest);
    // Credentials are checked at the operator boundary, before any stage burns
    // a minute of the twenty-minute budget.
    preflight(process.env);
    const result = await runDemoPipeline(args);
    process.stdout.write(result.liveUrl === undefined
      ? `Stopped before ship — the demo folder is at ${result.demoDir}\n`
      : `LIVE: ${result.liveUrl}\n`);
    return;
  }
  if (command === "fix") {
    const args = parseDemoFixArgs(rest);
    preflight(process.env);
    const result = await runDemoFix(args);
    process.stdout.write(result.liveUrl === undefined
      ? `Stopped before ship — the fixed demo is at ${result.demoDir}\n`
      : `LIVE: ${result.liveUrl}\n`);
    return;
  }
  throw new Error(`Unknown demo-creator command: ${command ?? "(missing)"} — expected "pipeline" or "fix"`);
}

main().catch((error) => {
  // ONE machine-readable failure line first (the Slack driver greps for it),
  // then the stack for the human reading the terminal.
  const cause = error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);
  process.stdout.write(`FAILED: ${cause}\n`);
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});
