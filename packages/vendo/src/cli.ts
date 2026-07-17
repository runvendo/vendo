import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runCloud } from "./cli/cloud/index.js";
import { runDoctor } from "./cli/doctor.js";
import { runInit } from "./cli/init.js";
import { runMcp } from "./cli/mcp/index.js";
import { runRefineCommand } from "./cli/refine.js";
import { CLI_VERSION } from "./cli/shared.js";
import { runSync } from "./cli/sync.js";

const HELP = `vendo — default Vendo composition

Usage: vendo <command> [dir] [options]

Commands:
  init [dir]      Scan, interview, write .vendo, and propose handler + VendoRoot wiring
  doctor [dir]    Verify wiring, present credentials, and actAs over live HTTP
  sync [dir]      Extract tools and remix baselines (use --strict for CI)
  refine [dir]    Propose compound capabilities, risk corrections, and brief updates as reviewable diffs
  mcp <command>   Generate MCP registry discovery and domain-verification files
  cloud <command> Use the public Vendo Cloud API

Options:
  --agent                    Init only: print a read-only plan — four questions, code diffs, extracted tools, risk recommendations
  --yes                      Init/refine: skip the interview and approve displayed changes
  --force                    Init/server-json: overwrite owned or generated files
  --model-import <specifier> Init/refine: module exporting the host's ai-SDK model
  --brief <text>             Init only: product brief used for non-interactive setup
  --ask <text>               Refine only: interview answer (repeatable) for non-interactive runs
  --url <url>                Doctor/refine/server-json: mounted wire base or public MCP URL
  --strict                   Sync only: exit 2 on breaking changes, 3 when saved references are impacted
  --json                     Sync only: print one machine-readable report object
  --report                   Sync only: push the report to Vendo Cloud
  --key <key>                Sync/cloud: override VENDO_API_KEY
  --api-url <url>            Sync/cloud: override VENDO_CLOUD_URL
  --version                  Print the version
`;

function option(args: string[], name: string): string | undefined {
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1];
  return args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1]!);
    else if (args[index]!.startsWith(`${name}=`)) values.push(args[index]!.slice(name.length + 1));
  }
  return values;
}

const INIT_FLAGS = new Set(["--agent", "--yes", "--force"]);
const INIT_VALUE_OPTIONS = ["--model-import", "--brief"];

/** ENG-335: init options the CLI does not recognize — or value options missing
    their value — must fail loudly before anything runs. Silently dropping a
    flag is how the "--agent writes nothing" promise broke in the field: an
    older CLI ignored --agent and ran a full, writing init. */
function initOptionErrors(args: string[]): string[] {
  const errors: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) continue;
    if (INIT_FLAGS.has(arg)) continue;
    if (INIT_VALUE_OPTIONS.includes(arg)) {
      // A value that looks like another flag is a missing value, not a value —
      // otherwise `--model-import --force` proceeds with modelImport "--force".
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) errors.push(`${arg} requires a value`);
      else index += 1;
      continue;
    }
    if (INIT_VALUE_OPTIONS.some((name) => arg.startsWith(`${name}=`))) continue;
    errors.push(`unknown option: ${arg}`);
  }
  return errors;
}

function target(args: string[]): string {
  const optionValues = new Set<string>();
  for (const name of ["--model-import", "--url", "--brief", "--key", "--api-url", "--ask"]) {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === name && args[index + 1] !== undefined) optionValues.add(args[index + 1]!);
    }
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
  if (command === "cloud") return runCloud(args);
  if (command === "mcp") return runMcp(args);
  if (command === "init") {
    const problems = initOptionErrors(args);
    if (problems.length > 0) {
      console.error(`vendo init: ${problems.join("; ")}\n\n${HELP}`);
      return 1;
    }
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
  if (command === "refine") {
    return runRefineCommand({
      targetDir: target(args),
      url: option(args, "--url"),
      modelImport: option(args, "--model-import"),
      asks: options(args, "--ask"),
      yes: args.includes("--yes"),
    });
  }
  if (command === "sync") {
    return runSync({
      targetDir: target(args),
      strict: args.includes("--strict"),
      url: option(args, "--url"),
      json: args.includes("--json"),
      report: args.includes("--report"),
      apiKey: option(args, "--key"),
      apiUrl: option(args, "--api-url"),
    });
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
