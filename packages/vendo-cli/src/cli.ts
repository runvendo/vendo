/**
 * @vendoai/cli — the one-click dev tool (ENG-197). The shebang is added by the
 * vite build banner (see vite.config.ts).
 *   vendo init [dir]     extract theme/tools/components into <dir>/.vendo/
 *   vendo publish [dir]  stub until the cloud registry lands (ENG-198)
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runInit } from "./init.js";
import { runPublish } from "./publish.js";
import { runSync } from "./sync/index.js";
import { runTelemetryCmd } from "./telemetry-cmd.js";

const HELP = `vendo — Vendo one-click dev tool

Usage:
  vendo init [dir] [--skip-llm] [--force]   Extract theme/tools/components into .vendo/ AND
                                              wire a Next.js App Router app (route handler,
                                              provider, .env.example, sandbox assets, prebuild sync)
  vendo sync [dir]                          Capture wrapped-component source + build the sandbox
                                              environment (deps, host CSS, manifest). Runs every
                                              build via the prebuild script init wires.
  vendo publish [dir]                       Publish the manifest (stub — registry lands with ENG-198)
  vendo telemetry <status|enable|disable>   View or change anonymous usage telemetry (see TELEMETRY.md)

Options:
  --skip-llm   Skip LLM-assisted steps (route scan, component discovery)
  --force      Overwrite existing .vendo/ files
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const dir = rest.find((a) => !a.startsWith("--")) ?? process.cwd();
  switch (cmd) {
    case "init":
      return runInit({ targetDir: dir, skipLlm: flags.has("--skip-llm"), force: flags.has("--force") });
    case "sync":
      return runSync({ targetDir: dir });
    case "publish":
      return runPublish({ targetDir: dir });
    case "telemetry":
      return runTelemetryCmd(rest.find((a) => !a.startsWith("--")), { log: (m) => console.log(m) });
    case "--version":
      console.log("0.0.0");
      return 0;
    default:
      console.log(HELP);
      return cmd === undefined || cmd === "--help" ? 0 : 1;
  }
}

// Only auto-run when invoked as a bin, not when imported by tests.
// Node resolves the main module through symlinks (npm's .bin/vendo is one) and
// pathToFileURL percent-encodes special characters, so compare against the
// realpath's file URL rather than a hand-built `file://` string.
export function isCliEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
