import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isVendoKey } from "./cli/cloud/client.js";
import { runLoginCommand } from "./cli/cloud/device-login.js";
import { runCloud } from "./cli/cloud/index.js";
import { runConfig } from "./cli/config.js";
import { runDoctor } from "./cli/doctor.js";
import { runEject } from "./cli/eject.js";
import { runInit, type InitOptions } from "./cli/init.js";
import { runKnowledge } from "./cli/knowledge/index.js";
import { runMcp } from "./cli/mcp/index.js";
import { CLI_VERSION } from "./cli/shared.js";
import { runSync } from "./cli/sync.js";

const HELP = `vendo — install your product's agent

Usage: vendo <command> [dir] [options]

Commands:
  init [dir]      Set up Vendo: wire the handler, extract tools + theme, resolve a model key
  login           Claim a Vendo Cloud key: approve in the browser; the key lands in .env.local
  doctor [dir]    Verify the install: wiring, live probes, and one real model turn (--json for agents)

Advanced:
  sync [dir]      Re-extract tools and baselines, then judge what moved — evidence-backed grades, loosenings held for a human (keyless: structural only; --strict is the CI gate)
  eject <surface> [dir]  Copy a shipped chrome surface's presentation source into your repo (--list to see surfaces)
  knowledge <verb> Sync local docs/glossary/API sources into the product knowledge base (add, list, remove, sync)
  mcp <command>   Generate MCP registry discovery and domain-verification files
  cloud <command> Use the public Vendo Cloud API
  config <command> Push/pull a .vendo surface to/from hosted config, or show surface owners

Options:
  --agent                    Init only: print a read-only JSON plan — code changes, extracted tools, risk recommendations
  --yes                      Init: accept the detected auth preset, skip the cloud offer + AI polish + theme review, end with the agent tail; doctor: auto-start the dev server
  --force                    Init/server-json: overwrite owned or generated files; eject: overwrite an ejected dir
  --auth <preset>            Init only: wire this auth preset without asking (authJs, clerk, supabase, auth0, jwt, none)
  --framework <name>         Init only: override framework detection (next, express, custom) — required non-interactively when detection fails
  --cloud-key <key>          Init only: write this Vendo Cloud key to .env.local instead of the login offer
  --wait <seconds>           Login only: bound this call's polling to N seconds (agents loop re-runs; each resumes the same request), then exit resumably
  --byo                      Init only: decline the Vendo Cloud offer (bring your own model key)
  --use-case <name>          Init only: how people will use the agent (embedded, agent-loop, mcp)
  --base-url <url>           Init only: this deployment's public URL — written to .env.example, never .env.local
  --posture <name>           Init only, --use-case mcp: how outside agents sign in (local, broker)
  --service-key              Init only, --use-case mcp: set up a machine-to-machine service key
  --check / --no-check       Init only: run vendo doctor at the end (offered only when no paste is outstanding)
  --ai                       Init/sync: run the AI judgment pass without asking (works non-interactively)
  --engine <name>            Init/sync: pin the AI engine (claude, codex, npx) instead of first-available
  --theme <slot=value>       Init only: override a theme slot value directly (repeatable)
  --list                     Eject only: show the ejectable surfaces
  --url <url>                Doctor/server-json: mounted wire base or public MCP URL
  --strict                   Sync only: exit 2 on breaking changes, 3 when saved references are impacted
  --review                   Sync only: show the queued + new loosenings and confirm before writing
  --full                     Sync only: judge the whole catalog instead of only what moved
  --theme-refresh            Sync only: take the theme scan's values even for slots you hand-edited
  --push-components          Sync only: send registered host-component source to Vendo Cloud without asking (CI)
  --no-push-components       Sync only: keep registered host-component source on this machine
  --no-ai                    Init/sync: force the AI judgment pass off
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

/** `--ai`/`--no-ai` is the canonical pair on BOTH init and sync (decision 2).
    `--ai-polish` (init) and `--no-watermark` (sync) are the documented older
    spellings and stay accepted so pinned scripts and hooks keep working. */
const INIT_FLAGS = new Set([
  "--agent", "--yes", "--force", "--byo", "--ai", "--ai-polish", "--no-ai",
  "--service-key", "--check", "--no-check",
]);
const INIT_VALUE_OPTIONS = ["--auth", "--framework", "--cloud-key", "--theme", "--engine", "--use-case", "--base-url", "--posture"];
/** Agent-install-dx: every init wizard question has a value-flag answer; a
    bad value fails as loudly as an unknown flag, with the valid choices. */
const INIT_AUTH_VALUES = ["authJs", "clerk", "supabase", "auth0", "jwt", "none"];
const INIT_FRAMEWORK_VALUES = ["next", "express", "custom"];
const INIT_USE_CASE_VALUES = ["embedded", "agent-loop", "mcp"];
const INIT_POSTURE_VALUES = ["local", "broker"];
/** The user-facing engine families (judge/engine.ts's ENGINE_FAMILIES values) —
    one ladder, so `init --engine` and `sync --engine` accept the same names. */
const ENGINE_VALUES = ["claude", "codex", "npx"];
const DOCTOR_FLAGS = new Set(["--json", "--yes"]);
const DOCTOR_VALUE_OPTIONS = ["--url"];
const SYNC_FLAGS = new Set([
  "--strict", "--json", "--report", "--review", "--full", "--yes",
  "--theme-refresh", "--ai", "--no-ai", "--no-watermark",
  "--push-components", "--no-push-components",
]);
const SYNC_VALUE_OPTIONS = ["--url", "--key", "--api-url", "--engine"];
const LOGIN_VALUE_OPTIONS = ["--api-url", "--wait"];

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

function target(args: string[]): string {
  const optionValues = new Set<string>();
  for (const name of ["--url", "--key", "--api-url", "--apply",
    "--auth", "--framework", "--cloud-key", "--theme", "--engine",
    "--use-case", "--base-url", "--posture"]) {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === name && args[index + 1] !== undefined) optionValues.add(args[index + 1]!);
    }
  }
  return args.find((value) => !value.startsWith("--") && !optionValues.has(value)) ?? process.cwd();
}

/** One function per command: each owns its own flag validation and the shape it
 *  hands its runner, so `main` below stays the flat table of what `vendo <x>`
 *  means. Every one of them prints `vendo <command>: <problems>` + HELP and
 *  exits 1 rather than passing a bad flag down. */
async function loginCommand(args: string[]): Promise<number> {
  const problems = optionErrors(args, new Set(), LOGIN_VALUE_OPTIONS);
  const wait = option(args, "--wait");
  if (wait !== undefined && !/^\d+$/.test(wait)) {
    problems.push("--wait takes a whole number of seconds (example: vendo login --wait 90)");
  }
  if (problems.length > 0) {
    console.error(`vendo login: ${problems.join("; ")}\n\n${HELP}`);
    return 1;
  }
  return runLoginCommand(args);
}

async function initCommand(args: string[]): Promise<number> {
  const problems = optionErrors(args, INIT_FLAGS, INIT_VALUE_OPTIONS);
  const auth = option(args, "--auth");
  if (auth !== undefined && !INIT_AUTH_VALUES.includes(auth)) {
    problems.push(`--auth must be one of ${INIT_AUTH_VALUES.join(", ")} (example: vendo init --auth clerk)`);
  }
  const framework = option(args, "--framework");
  if (framework !== undefined && !INIT_FRAMEWORK_VALUES.includes(framework)) {
    problems.push("--framework must be next, express, or custom (example: vendo init --framework custom for a Cloudflare Worker / Bun / Deno host)");
  }
  const cloudKey = option(args, "--cloud-key");
  if (cloudKey !== undefined && !isVendoKey(cloudKey)) {
    problems.push("--cloud-key must be a Vendo Cloud key (vnd_ + 40 hex; `vendo login` issues one)");
  }
  const engine = option(args, "--engine");
  if (engine !== undefined && !ENGINE_VALUES.includes(engine)) {
    problems.push(`--engine must be one of ${ENGINE_VALUES.join(", ")} (example: vendo init --engine codex)`);
  }
  if (cloudKey !== undefined && args.includes("--byo")) {
    problems.push("--cloud-key and --byo answer the same question — pass one or the other");
  }
  const initAi = args.includes("--ai") || args.includes("--ai-polish");
  if (initAi && args.includes("--no-ai")) {
    problems.push("--ai and --no-ai answer the same question — pass one or the other");
  }
  const themePairs = options(args, "--theme");
  const badTheme = themePairs.find((pair) => !/^[A-Za-z]+=./.test(pair));
  if (badTheme !== undefined) {
    problems.push(`--theme takes slot=value (example: vendo init --theme accent=#7c3bed), got ${JSON.stringify(badTheme)}`);
  }
  const useCase = option(args, "--use-case");
  if (useCase !== undefined && !INIT_USE_CASE_VALUES.includes(useCase)) {
    problems.push(`--use-case must be one of ${INIT_USE_CASE_VALUES.join(", ")} (example: vendo init --use-case mcp)`);
  }
  const baseUrl = option(args, "--base-url");
  if (baseUrl !== undefined && !/^https?:\/\/\S+$/.test(baseUrl)) {
    problems.push(`--base-url must be this deployment's full public URL (example: vendo init --base-url https://app.acme.com), got ${JSON.stringify(baseUrl)}`);
  }
  const posture = option(args, "--posture");
  if (posture !== undefined && !INIT_POSTURE_VALUES.includes(posture)) {
    problems.push(`--posture must be local or broker (example: vendo init --use-case mcp --posture broker)`);
  }
  // Both answers belong to questions only the MCP path asks — silently
  // ignoring them would leave an operator believing they took effect.
  const serviceKey = args.includes("--service-key");
  if ((posture !== undefined || serviceKey) && useCase !== "mcp") {
    problems.push(`${posture === undefined ? "--service-key" : "--posture"} only applies to --use-case mcp (pass --use-case mcp, or drop it)`);
  }
  if (args.includes("--check") && args.includes("--no-check")) {
    problems.push("--check and --no-check answer the same question — pass one or the other");
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
    ...(initAi ? { ai: true } : args.includes("--no-ai") ? { ai: false } : {}),
    ...(engine === undefined ? {} : { engine }),
    ...(useCase === undefined ? {} : { useCase: useCase as InitOptions["useCase"] }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(posture === undefined ? {} : { posture: posture as InitOptions["posture"] }),
    ...(serviceKey ? { serviceKey: true } : {}),
    ...(args.includes("--check") ? { check: true } : args.includes("--no-check") ? { check: false } : {}),
    ...(themePairs.length === 0 ? {} : {
      themeAnswers: Object.fromEntries(themePairs.map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), pair.slice(at + 1)];
      })),
    }),
  });
}

async function ejectCommand(args: string[]): Promise<number> {
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

async function doctorCommand(args: string[]): Promise<number> {
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

async function syncCommand(args: string[]): Promise<number> {
  const problems = optionErrors(args, SYNC_FLAGS, SYNC_VALUE_OPTIONS);
  const engine = option(args, "--engine");
  if (engine !== undefined && !ENGINE_VALUES.includes(engine)) {
    problems.push(`--engine must be one of ${ENGINE_VALUES.join(", ")} (example: vendo sync --engine codex)`);
  }
  if (args.includes("--review") && args.includes("--json")) {
    problems.push("--review is interactive and cannot combine with --json");
  }
  const syncNoAi = args.includes("--no-ai") || args.includes("--no-watermark");
  if (args.includes("--ai") && syncNoAi) {
    problems.push("--ai and --no-ai answer the same question — pass one or the other");
  }
  if (args.includes("--push-components") && args.includes("--no-push-components")) {
    problems.push("--push-components and --no-push-components answer the same question — pass one or the other");
  }
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
    review: args.includes("--review"),
    full: args.includes("--full"),
    yes: args.includes("--yes"),
    themeRefresh: args.includes("--theme-refresh"),
    ...(args.includes("--ai") ? { ai: true } : syncNoAi ? { ai: false } : {}),
    ...(args.includes("--push-components") ? { pushComponents: true }
      : args.includes("--no-push-components") ? { pushComponents: false } : {}),
    ...(engine === undefined ? {} : { engine }),
  });
}

/** #1154: `--help`/`-h` after one of these command names asks for the help
    text — without this it reaches optionErrors and comes back as
    `unknown option: --help`, exit 1. The group commands (cloud/config/
    knowledge/mcp) print their own help, and an unknown command stays loud. */
const HELP_COMMANDS = new Set(["login", "init", "eject", "doctor", "sync"]);

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
  if (HELP_COMMANDS.has(command) && (args.includes("--help") || args.includes("-h"))) {
    console.log(HELP);
    return 0;
  }
  if (command === "login") return loginCommand(args);
  if (command === "cloud") return runCloud(args);
  if (command === "config") return runConfig(args);
  if (command === "knowledge") return runKnowledge(args);
  if (command === "mcp") return runMcp(args);
  if (command === "init") return initCommand(args);
  if (command === "eject") return ejectCommand(args);
  if (command === "doctor") return doctorCommand(args);
  if (command === "refine") {
    // Retired in #568 (format v3): `vendo sync` now owns AI enrichment of
    // .vendo (compounds/briefs live in .vendo/overrides.json).
    console.error("vendo refine was retired — `vendo sync` AI-enriches .vendo now (compounds and briefs live in .vendo/overrides.json). Run: vendo sync");
    return 1;
  }
  if (command === "playground") {
    // Retired, and the hosted surface behind it is gone too — this notice is
    // all that is left, and it only catches the old command name.
    console.error("vendo playground was retired — set Vendo up in your own repo instead: `vendo init`, then `vendo doctor`. Docs: https://vendo.run/quickstart");
    return 1;
  }
  if (command === "sync") return syncCommand(args);
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
