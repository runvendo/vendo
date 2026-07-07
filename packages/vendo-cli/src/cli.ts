/**
 * @vendoai/cli — the one-click dev tool (ENG-197). The shebang is added by the
 * vite build banner (see vite.config.ts).
 *
 * Three tiers of commands:
 *   vendo init [dir]     set up Vendo in a Next.js app (run once)
 *   vendo refresh [dir]  catch up an existing install; offers only what's new
 *   vendo doctor [dir]   check the install (read-only)
 * plus vendo sync (automatic in your build) and vendo publish (ENG-198 stub).
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runInit } from "./init.js";
import { runRefresh } from "./refresh.js";
import { runDoctor } from "./doctor.js";
import { runPublish } from "./publish.js";
import { runSync } from "./sync/index.js";
import { runTelemetryCmd } from "./telemetry-cmd.js";
import { CLI_VERSION } from "./version.js";

const HELP = `vendo — Vendo one-click dev tool

Usage: vendo <command> [dir] [options]

Setup (you run these):
  init [dir]      Set up Vendo in a Next.js app: extract theme/tools/components into
                  .vendo/ and wire the app (route handler, provider, sandbox assets,
                  prebuild sync). Interactive — prompts for a provider key and lets you
                  pick components to wrap and widgets to make remixable. Safe to re-run:
                  fills missing setup, never overwrites, and keeps an existing
                  component catalog stable.
  refresh [dir]   Catch up an existing install: fill gaps and offer only what's new,
                  with the same pickers as init. Run it after your app has grown.
  doctor [dir]    Check your Vendo install — keys, wiring, .vendo state, storage,
                  scheduler, telemetry — and report problems with fixes. Read-only.

Runs automatically in your build:
  sync [dir]      Capture wrapped-component source + rebuild the sandbox environment.
                  init wires this into your prebuild script; you rarely run it by hand.

Coming with the registry:
  publish [dir]   Validate and (soon) publish the manifest — stub until ENG-198.

Management:
  telemetry <status|enable|disable>   View or change anonymous usage telemetry (TELEMETRY.md)

Options:
  --skip-llm   Skip LLM-assisted steps (route scan, component/remix discovery)
  --force      Overwrite existing .vendo/ files (init/refresh; warns before overwriting)
  --yes        Non-interactive: no prompts; resolve keys from env / .env.local only;
               skip the component/remix pickers (source edits stay human-gated)
  --local      Pack local vendo + @vendoai packages from a Vendo monorepo into ./vendor
  --version    Print the CLI version
`;

export function parseInitArgs(args: string[]):
  | { ok: true; targetDir: string; skipLlm: boolean; force: boolean; yes: boolean; localVendoDir?: string }
  | { ok: false; error: string } {
  const positionals: string[] = [];
  let localVendoDir: string | undefined;
  let skipLlm = false;
  let force = false;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--skip-llm") {
      skipLlm = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--yes") {
      yes = true;
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
  return { ok: true, targetDir: positionals[0] ?? process.cwd(), skipLlm, force, yes, localVendoDir };
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const dir = rest.find((a) => !a.startsWith("--")) ?? process.cwd();
  switch (cmd) {
    case "init":
    case "refresh": {
      const parsed = parseInitArgs(rest);
      if (!parsed.ok) {
        console.error(parsed.error);
        return 1;
      }
      const opts = {
        targetDir: parsed.targetDir,
        skipLlm: parsed.skipLlm,
        force: parsed.force,
        yes: parsed.yes,
        localVendoDir: parsed.localVendoDir,
      };
      // `refresh` is init's catch-up mode; `init` on an already-wired app
      // delegates to the same behavior (see init.ts / refresh.ts).
      return cmd === "refresh" ? runRefresh(opts) : runInit(opts);
    }
    case "doctor":
      return runDoctor({ targetDir: dir });
    case "sync":
      return runSync({ targetDir: dir });
    case "publish":
      return runPublish({ targetDir: dir });
    case "telemetry":
      return runTelemetryCmd(rest.find((a) => !a.startsWith("--")), { log: (m) => console.log(m) });
    case "--version":
      console.log(CLI_VERSION);
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
