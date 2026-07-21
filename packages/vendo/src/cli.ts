import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isVendoKey } from "./cli/cloud/client.js";
import { runDeviceLogin } from "./cli/cloud/device-login.js";
import { runCloud } from "./cli/cloud/index.js";
import { runDoctor } from "./cli/doctor.js";
import { runEject } from "./cli/eject.js";
import { runExtractApply } from "./cli/extract/apply.js";
import { runInit, type InitOptions } from "./cli/init.js";
import { runMcp } from "./cli/mcp/index.js";
import { runPlayground } from "./cli/playground.js";
import { runRefineCommand } from "./cli/refine.js";
import { CLI_VERSION } from "./cli/shared.js";
import { runSync } from "./cli/sync.js";

const HELP = `vendo — install your product's agent

Usage: vendo <command> [dir] [options]

Commands:
  init [dir]      Set up Vendo: wire the handler, extract tools + theme, resolve a model key
  login [email]   Claim a Vendo Cloud key: approve in the browser; the key lands in .env.local
  doctor [dir]    Verify the install: wiring, live probes, and one real model turn (--json for agents)

Advanced:
  sync [dir]      Re-extract tools and baselines (init hooks this into predev/prebuild; --strict is the CI gate)
  eject <surface> [dir]  Copy a shipped chrome surface's presentation source into your repo (--list to see surfaces)
  extract [dir]   Apply a coding agent's extraction draft through the deterministic guards (--apply <draft.json>)
  refine [dir]    Propose compound capabilities, risk corrections, and brief updates as reviewable diffs
  playground      Render every Vendo surface against scripted data in the browser — no model key needed
  mcp <command>   Generate MCP registry discovery and domain-verification files
  cloud <command> Use the public Vendo Cloud API

Options:
  --agent                    Init only: print a read-only JSON plan — code changes, extracted tools, risk recommendations, the aiPolish delegation contract
  --apply <draft.json>       Extract only: draft file an external agent produced from the plan's aiPolish contract
  --yes                      Init: skip the cloud-login offer; refine: approve displayed diffs; doctor: auto-start the dev server
  --force                    Init/server-json: overwrite owned or generated files; eject: overwrite an ejected dir
  --auth <preset>            Init only: wire this auth preset without asking (authJs, clerk, supabase, auth0, jwt, none)
  --framework <name>         Init only: override framework detection (next, express) — required non-interactively when detection fails
  --cloud-key <key>          Init only: write this Vendo Cloud key to .env.local instead of the login offer
  --email <address>          Login only: pre-fill the approval page (login hint)
  --byo                      Init only: decline the Vendo Cloud offer (bring your own model key)
  --ai-polish                Init only: consent to the AI extraction pass without a prompt (works non-interactively)
  --engine <name>            Init only: pin the AI-polish engine (claude, codex, npx) instead of first-available
  --theme <slot=value>       Init only: override a theme slot value directly (repeatable)
  --list                     Eject only: show the ejectable surfaces
  --model-import <specifier> Refine only: module exporting the host's ai-SDK model
  --ask <text>               Refine only: interview answer (repeatable) for non-interactive runs
  --url <url>                Doctor/refine/server-json: mounted wire base or public MCP URL
  --strict                   Sync only: exit 2 on breaking changes, 3 when saved references are impacted
  --port <port>              Playground only: listen on a fixed port (default: any free port)
  --no-open                  Playground only: print the URL without opening the browser
  --json                     Sync/doctor: print one machine-readable report object
  --report                   Sync only: push the report to Vendo Cloud
  --key <key>                Sync/cloud: override VENDO_API_KEY
  --api-url <url>            Sync/cloud/login: override VENDO_CLOUD_URL
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

const INIT_FLAGS = new Set(["--agent", "--yes", "--force", "--byo", "--ai-polish"]);
const INIT_VALUE_OPTIONS = ["--auth", "--framework", "--cloud-key", "--theme", "--engine"];
/** Agent-install-dx: every init wizard question has a value-flag answer; a
    bad value fails as loudly as an unknown flag, with the valid choices. */
const INIT_AUTH_VALUES = ["authJs", "clerk", "supabase", "auth0", "jwt", "none"];
const INIT_FRAMEWORK_VALUES = ["next", "express"];
const INIT_ENGINE_VALUES = ["claude", "codex", "npx"];
const EXTRACT_FLAGS = new Set(["--force"]);
const EXTRACT_VALUE_OPTIONS = ["--apply"];
const DOCTOR_FLAGS = new Set(["--json", "--yes"]);
const DOCTOR_VALUE_OPTIONS = ["--url"];
const REFINE_FLAGS = new Set(["--yes"]);
const REFINE_VALUE_OPTIONS = ["--url", "--model-import", "--ask"];
const SYNC_FLAGS = new Set(["--strict", "--json", "--report"]);
const SYNC_VALUE_OPTIONS = ["--url", "--key", "--api-url"];
const LOGIN_VALUE_OPTIONS = ["--email", "--api-url"];

/** ENG-335: options the CLI does not recognize — or value options missing
    their value — must fail loudly before anything runs. Silently dropping a
    flag is how the "--agent writes nothing" promise broke in the field: an
    older CLI ignored --agent and ran a full, writing init. */
function optionErrors(args: string[], flags: Set<string>, valueOptions: string[]): string[] {
  const errors: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) continue;
    if (flags.has(arg)) continue;
    if (valueOptions.includes(arg)) {
      // A value that looks like another flag is a missing value, not a value —
      // otherwise `--model-import --force` proceeds with modelImport "--force".
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) errors.push(`${arg} requires a value`);
      else index += 1;
      continue;
    }
    if (valueOptions.some((name) => arg.startsWith(`${name}=`))) continue;
    errors.push(`unknown option: ${arg}`);
  }
  return errors;
}

/** Playground follows the ENG-335 rule too: unknown flags fail loudly. */
function playgroundOptionErrors(args: string[]): { errors: string[]; port?: number } {
  const errors: string[] = [];
  let port: number | undefined;
  const parsePort = (value: string | undefined, flag: string): void => {
    const parsed = value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN;
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) port = parsed;
    else errors.push(`${flag} requires a port number (1-65535)`);
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--no-open") continue;
    if (arg === "--port") {
      const value = args[index + 1];
      parsePort(value !== undefined && value.startsWith("--") ? undefined : value, "--port");
      if (value !== undefined && !value.startsWith("--")) index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      parsePort(arg.slice("--port=".length), "--port");
      continue;
    }
    errors.push(arg.startsWith("--") ? `unknown option: ${arg}` : `unexpected argument: ${arg}`);
  }
  return { errors, port };
}

function target(args: string[]): string {
  const optionValues = new Set<string>();
  for (const name of ["--model-import", "--url", "--key", "--api-url", "--ask", "--apply",
    "--auth", "--framework", "--cloud-key", "--theme"]) {
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
  if (command === "login") {
    const problems = optionErrors(args, new Set(), LOGIN_VALUE_OPTIONS);
    if (problems.length > 0) {
      console.error(`vendo login: ${problems.join("; ")}\n\n${HELP}`);
      return 1;
    }
    return runDeviceLogin(args);
  }
  if (command === "cloud") return runCloud(args);
  if (command === "mcp") return runMcp(args);
  if (command === "init") {
    const problems = optionErrors(args, INIT_FLAGS, INIT_VALUE_OPTIONS);
    const auth = option(args, "--auth");
    if (auth !== undefined && !INIT_AUTH_VALUES.includes(auth)) {
      problems.push(`--auth must be one of ${INIT_AUTH_VALUES.join(", ")} (example: vendo init --auth clerk)`);
    }
    const framework = option(args, "--framework");
    if (framework !== undefined && !INIT_FRAMEWORK_VALUES.includes(framework)) {
      problems.push("--framework must be next or express (example: vendo init --framework next)");
    }
    const cloudKey = option(args, "--cloud-key");
    if (cloudKey !== undefined && !isVendoKey(cloudKey)) {
      problems.push("--cloud-key must be a Vendo Cloud key (vnd_ + 40 hex; `vendo login` issues one)");
    }
    const engine = option(args, "--engine");
    if (engine !== undefined && !INIT_ENGINE_VALUES.includes(engine)) {
      problems.push(`--engine must be one of ${INIT_ENGINE_VALUES.join(", ")} (example: vendo init --engine codex)`);
    }
    if (cloudKey !== undefined && args.includes("--byo")) {
      problems.push("--cloud-key and --byo answer the same question — pass one or the other");
    }
    const themePairs = options(args, "--theme");
    const badTheme = themePairs.find((pair) => !/^[A-Za-z]+=./.test(pair));
    if (badTheme !== undefined) {
      problems.push(`--theme takes slot=value (example: vendo init --theme accent=#7c3bed), got ${JSON.stringify(badTheme)}`);
    }
    if (problems.length > 0) {
      console.error(`vendo init: ${problems.join("; ")}\n\n${HELP}`);
      return 1;
    }
    return runInit({
      targetDir: target(args),
      agent: args.includes("--agent"),
      yes: args.includes("--yes"),
      force: args.includes("--force"),
      ...(auth === undefined ? {} : { auth: auth as InitOptions["auth"] }),
      ...(framework === undefined ? {} : { framework: framework as InitOptions["framework"] }),
      ...(cloudKey === undefined ? {} : { cloudKey }),
      ...(args.includes("--byo") ? { byo: true } : {}),
      ...(args.includes("--ai-polish") ? { aiPolish: true } : {}),
      ...(engine === undefined ? {} : { engine }),
      ...(themePairs.length === 0 ? {} : {
        themeAnswers: Object.fromEntries(themePairs.map((pair) => {
          const at = pair.indexOf("=");
          return [pair.slice(0, at), pair.slice(at + 1)];
        })),
      }),
    });
  }
  if (command === "extract") {
    const problems = optionErrors(args, EXTRACT_FLAGS, EXTRACT_VALUE_OPTIONS);
    if (!args.some((arg) => arg === "--apply" || arg.startsWith("--apply="))) {
      problems.push("--apply <draft.json> is required");
    } else if (option(args, "--apply") === "") {
      // `--apply=` slips past the missing-value check with an empty string,
      // which would resolve to the cwd instead of failing loudly.
      problems.push("--apply requires a value");
    }
    if (problems.length > 0) {
      console.error(`vendo extract: ${problems.join("; ")}\n\n${HELP}`);
      return 1;
    }
    return runExtractApply({
      targetDir: target(args),
      apply: option(args, "--apply")!,
      force: args.includes("--force"),
    });
  }
  if (command === "eject") {
    const positional = args.filter((value) => !value.startsWith("--"));
    const list = args.includes("--list");
    // `eject --list [dir]` has no surface positional — the first one is the dir.
    return runEject({
      surface: list ? undefined : positional[0],
      targetDir: (list ? positional[0] : positional[1]) ?? process.cwd(),
      list,
      force: args.includes("--force"),
    });
  }
  if (command === "doctor") {
    const problems = optionErrors(args, DOCTOR_FLAGS, DOCTOR_VALUE_OPTIONS);
    if (problems.length > 0) {
      console.error(`vendo doctor: ${problems.join("; ")}\n\n${HELP}`);
      return 1;
    }
    return runDoctor({
      targetDir: target(args),
      url: option(args, "--url"),
      json: args.includes("--json"),
      yes: args.includes("--yes"),
    });
  }
  if (command === "refine") {
    const problems = optionErrors(args, REFINE_FLAGS, REFINE_VALUE_OPTIONS);
    if (problems.length > 0) {
      console.error(`vendo refine: ${problems.join("; ")}\n\n${HELP}`);
      return 1;
    }
    return runRefineCommand({
      targetDir: target(args),
      url: option(args, "--url"),
      modelImport: option(args, "--model-import"),
      asks: options(args, "--ask"),
      yes: args.includes("--yes"),
    });
  }
  if (command === "playground") {
    const { errors, port } = playgroundOptionErrors(args);
    if (errors.length > 0) {
      console.error(`vendo playground: ${errors.join("; ")}\n\n${HELP}`);
      return 1;
    }
    return runPlayground({ port, open: !args.includes("--no-open") });
  }
  if (command === "sync") {
    const problems = optionErrors(args, SYNC_FLAGS, SYNC_VALUE_OPTIONS);
    if (problems.length > 0) {
      console.error(`vendo sync: ${problems.join("; ")}\n\n${HELP}`);
      return 1;
    }
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
