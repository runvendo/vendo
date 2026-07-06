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
  vendo init [dir] [--skip-llm] [--force] [--local <vendo-monorepo>]
                                            Extract theme/tools/components into .vendo/ AND
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
  --local      Pack local @vendoai packages from a Vendo monorepo into ./vendor
`;

function parseInitArgs(args: string[]):
  | { ok: true; targetDir: string; skipLlm: boolean; force: boolean; localVendoDir?: string }
  | { ok: false; error: string } {
  const positionals: string[] = [];
  let localVendoDir: string | undefined;
  let skipLlm = false;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--skip-llm") {
      skipLlm = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--local") {
      const value = args[++i];
      if (!value || value.startsWith("--")) return { ok: false, error: "--local requires a path to the Vendo monorepo" };
      localVendoDir = value;
    } else if (arg.startsWith("--local=")) {
      localVendoDir = arg.slice("--local=".length);
      if (!localVendoDir) return { ok: false, error: "--local requires a path to the Vendo monorepo" };
    } else if (!arg.startsWith("--")) {
      positionals.push(arg);
    }
  }
  return { ok: true, targetDir: positionals[0] ?? process.cwd(), skipLlm, force, localVendoDir };
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const dir = rest.find((a) => !a.startsWith("--")) ?? process.cwd();
  switch (cmd) {
    case "init": {
      const parsed = parseInitArgs(rest);
      if (!parsed.ok) {
        console.error(parsed.error);
        return 1;
      }
      return runInit({
        targetDir: parsed.targetDir,
        skipLlm: parsed.skipLlm,
        force: parsed.force,
        localVendoDir: parsed.localVendoDir,
      });
    }
    case "sync":
      return runSync({ targetDir: dir });
    case "publish":
      return runPublish({ targetDir: dir });
    case "telemetry":
      return runTelemetryCmd(rest.find((a) => !a.startsWith("--")), { log: (m) => console.log(m) });
    case "--version":
      console.log("0.1.0");
      return 0;
    default:
      console.log(HELP);
      return cmd === undefined || cmd === "--help" ? 0 : 1;
  }
}

// Only auto-run when invoked as a bin, not when imported by tests.
// Node resolves the main module through symlinks (npm's .bin/vendo is one) and
// pathToFileURL percent-encodes special characters (a checkout path with
// spaces), so compare against the realpath's file URL, not a hand-built
// `file://` string. Exported so the entrypoint logic is unit-testable.
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
