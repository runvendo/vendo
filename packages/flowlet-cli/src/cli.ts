/**
 * @flowlet/cli — the one-click dev tool (ENG-197). The shebang is added by the
 * vite build banner (see vite.config.ts).
 *   flowlet init [dir]     extract theme/tools/components into <dir>/.flowlet/
 *   flowlet publish [dir]  stub until the cloud registry lands (ENG-198)
 */
import { runInit } from "./init.js";
import { runPublish } from "./publish.js";
import { runSync } from "./sync/index.js";

const HELP = `flowlet — Flowlet one-click dev tool

Usage:
  flowlet init [dir] [--skip-llm] [--force]   Extract theme/tools/components into .flowlet/ AND
                                              wire a Next.js App Router app (route handler,
                                              provider, .env.example, sandbox assets, prebuild sync)
  flowlet sync [dir]                          Capture wrapped-component source + build the sandbox
                                              environment (deps, host CSS, manifest). Runs every
                                              build via the prebuild script init wires.
  flowlet publish [dir]                       Publish the manifest (stub — registry lands with ENG-198)

Options:
  --skip-llm   Skip LLM-assisted steps (route scan, component discovery)
  --force      Overwrite existing .flowlet/ files
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
    case "--version":
      console.log("0.0.0");
      return 0;
    default:
      console.log(HELP);
      return cmd === undefined || cmd === "--help" ? 0 : 1;
  }
}

// Only auto-run when invoked as a bin, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
