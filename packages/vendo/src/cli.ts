import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runDoctor } from "./cli/doctor.js";
import { runInit } from "./cli/init.js";
import { CLI_VERSION } from "./cli/shared.js";
import { runSync } from "./cli/sync.js";

const HELP = `vendo — default Vendo composition\n\nUsage: vendo <command> [dir] [options]\n\nCommands:\n  init [dir]      Scan, interview, write .vendo, and propose handler + VendoRoot wiring\n  doctor [dir]    Verify wiring and make one live /status round-trip\n  sync [dir]      Extract tools and remix baselines (use --strict for CI)\n\nOptions:\n  --agent         Init only: print a read-only plan with at most three questions\n  --yes           Init only: approve the displayed code changes\n  --force         Init only: regenerate owned .vendo files\n  --model-import  Init only: module exporting the host's ai-SDK model\n  --url           Doctor only: mounted wire base (default http://localhost:3000/api/vendo)\n  --strict        Sync only: exit 2 on breaking changes\n  --version       Print the version\n`;

function option(args: string[], name: string): string | undefined {
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1];
  return args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function target(args: string[]): string {
  const optionValues = new Set<string>();
  for (const name of ["--model-import", "--url", "--brief"]) {
    const index = args.indexOf(name);
    if (index >= 0 && args[index + 1] !== undefined) optionValues.add(args[index + 1]!);
  }
  return args.find((value) => !value.startsWith("--") && !optionValues.has(value)) ?? process.cwd();
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    console.log(CLI_VERSION);
    return 0;
  }
  if (command === "init") {
    return runInit({
      targetDir: target(args),
      agent: args.includes("--agent"),
      yes: args.includes("--yes"),
      force: args.includes("--force"),
      modelImport: option(args, "--model-import"),
      brief: option(args, "--brief"),
    });
  }
  if (command === "doctor") {
    return runDoctor({ targetDir: target(args), url: option(args, "--url") });
  }
  if (command === "sync") {
    return runSync({ targetDir: target(args), strict: args.includes("--strict") });
  }
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}

export function isCliEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
