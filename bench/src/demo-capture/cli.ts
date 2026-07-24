#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBrowserCapture, runConfigCapture } from "./capture.js";
import { parseDemoCaptureArgs } from "./cli-args.js";
import { assembleCorpusMontage } from "./montage.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function usage(): string {
  return `Usage:
  pnpm --filter @vendoai/bench demo:capture -- streaming-first-paint [--host maple|cadence|both] [--run-id ID]
  pnpm --filter @vendoai/bench demo:capture -- host-component [--host maple|cadence|both] [--prompt TEXT]
  pnpm --filter @vendoai/bench demo:capture -- remix-edit [--host maple|cadence|both] [--prompt TEXT] [--edit-prompt TEXT]
  pnpm --filter @vendoai/bench demo:capture -- demo-beats --host-config APP_DIR [--run-id ID]
  pnpm --filter @vendoai/bench demo:capture -- corpus-montage --gallery-run DIR [--repos a,b,c,d,e] [--output FILE]

Browser options: --port N --timeout-ms N --headed --no-boot [--url URL] --output-dir DIR
Montage options: --fps N --duration N --panel-width N --panel-height N`;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const args = parseDemoCaptureArgs(process.argv.slice(2));
  if (args.beat === "corpus-montage") {
    const output = path.resolve(args.output ?? path.join(
      repoRoot,
      "bench",
      "demo-capture",
      "output",
      path.basename(path.resolve(args.galleryRun)),
      "corpus-montage.gif",
    ));
    const pairs = await assembleCorpusMontage({
      galleryRun: path.resolve(args.galleryRun),
      output,
      ...(args.repos === undefined ? {} : { repos: args.repos }),
      fps: args.fps,
      durationSeconds: args.durationSeconds,
      panelWidth: args.panelWidth,
      panelHeight: args.panelHeight,
    });
    process.stdout.write(`${JSON.stringify({ beat: args.beat, output, repos: pairs.map((pair) => pair.repo) }, null, 2)}\n`);
    return;
  }
  const result = args.beat === "demo-beats"
    ? await runConfigCapture(args)
    : await runBrowserCapture(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});
