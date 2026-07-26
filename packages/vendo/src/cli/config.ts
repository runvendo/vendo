import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_SURFACES, isConfigSurface, OVERRIDES_ENABLEMENT_CAVEAT, type ConfigSurfaceName } from "../config-surface.js";
import { option, positionals } from "./cloud/args.js";
import type { CloudFetchOptions } from "./cloud/client.js";
import {
  commandContext,
  type CloudCommandOptions,
  type CloudFetcher,
} from "./cloud/command.js";
import { mergeEnvOverDotEnv, readDotEnvFallback } from "./doctor.js";
import { askYesNo, consoleOutput, exists, readOptional, writeText, type Output } from "./shared.js";

/** `vendo config` (unified auth) — move a `.vendo` content surface between local
 * disk and the hosted console, and report each surface's resolved OWNER.
 *
 * The seam this drives (selectConfigSurface): per surface, resolution is
 * explicit → local `.vendo` file → cloud published value. There is ONE source
 * of truth per surface and no bidirectional sync, so these verbs EJECT rather
 * than merge two live copies:
 *   - `push <surface>`  writes the local file into the console DRAFT (publish
 *     stays a console action) and offers to delete the local file, making cloud
 *     the single source.
 *   - `pull <surface>`  writes the console value (PUBLISHED by default, `--draft`
 *     for the working draft) into the local `.vendo` file, ejecting cloud→file.
 *   - `config status`   lists each surface's owner (file / cloud / unset).
 *
 * These are all PROJECT-SCOPED, so they authenticate with the single project
 * credential — VENDO_API_KEY — against the key-authed console plane (the
 * project is derived from the key), NOT the user session. `vendo login` mints
 * that key, so one login is enough; there is no separate session to go stale.
 * `explicit` (a programmatic override in createVendo) is not visible to the
 * CLI, so `config status` reports only file / cloud / unset. */

export interface ConfigCommandOptions extends CloudCommandOptions {
  targetDir?: string;
  /** Push: delete the local file without asking (also read from `--yes`). */
  yes?: boolean;
  /** askYesNo seam (tests inject a deterministic answer). */
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
}

const CONFIG_HELP = `vendo config — resolve, push, and pull hosted config surfaces

Usage:
  vendo config status [dir]              Show each surface's owner (file / cloud / unset)
  vendo config push <surface> [dir]      Write the local .vendo file into the console draft
  vendo config pull <surface> [dir]      Write the console value into the local .vendo file

All commands authenticate with VENDO_API_KEY (run \`vendo login\` to mint one);
the project is derived from the key.

Surfaces: ${CONFIG_SURFACES.join(", ")}

Options:
  --draft            Pull only: pull the working draft instead of the published value
  --yes              Push only: delete the local file without asking (cloud becomes the source)
  --key <key>        Override VENDO_API_KEY
  --api-url <url>    Override VENDO_CLOUD_URL / https://console.vendo.run
`;

function vendoPath(targetDir: string, surface: ConfigSurfaceName): string {
  return join(targetDir, ".vendo", surface);
}

/** Value-taking flags whose VALUE must never be read as the surface or dir.
 *  A bare `--key X` leaks `X` into a naive non-`--` scan, so the surface or
 *  target dir is silently wrong (Devin/Greptile P2 — the same class as cli.ts's
 *  --engine target() fix). `positionals()` strips each `<opt> <value>` pair,
 *  which fixes BOTH orderings (`push <surface> --key X` and
 *  `push --key X <surface>`). Boolean flags (--draft, --yes) take no value. */
const CONFIG_VALUE_OPTIONS = ["--key", "--api-url"];

/** The key-authed console DRAFT plane (project derived from the key). Mirrors
 *  the published read `/api/v1/config`; PUT replaces the whole draft doc. */
const DRAFT_PATH = "/api/v1/config/draft";

function surfaceArg(args: string[]): { surface?: ConfigSurfaceName; error?: string } {
  const positional = positionals(args, CONFIG_VALUE_OPTIONS)[0];
  if (positional === undefined) return { error: "a surface is required" };
  if (!isConfigSurface(positional)) {
    return { error: `unknown surface ${JSON.stringify(positional)}. Known surfaces: ${CONFIG_SURFACES.join(", ")}` };
  }
  return { surface: positional };
}

/** The project dir positional. push/pull consume a leading surface positional,
 *  so their dir is positionals[1]; status has no surface, so its dir is
 *  positionals[0]. Either way, value-flag values are stripped first so a bare
 *  `--project X` is never read as the dir. */
function targetDir(args: string[], options: ConfigCommandOptions, afterSurface: boolean): string {
  if (options.targetDir !== undefined) return options.targetDir;
  const pos = positionals(args, CONFIG_VALUE_OPTIONS);
  return (afterSurface ? pos[1] : pos[0]) ?? process.cwd();
}

function keyOptions(args: string[], options: ConfigCommandOptions): CloudFetchOptions {
  return {
    auth: "key",
    ...(option(args, "--key") === undefined ? {} : { apiKey: option(args, "--key") }),
    ...(option(args, "--api-url") === undefined ? {} : { apiUrl: option(args, "--api-url") }),
    home: options.home,
    env: options.env ?? process.env,
  };
}

/** Load the project's dotenv (`.env` then `.env.local`; local wins) and merge
 *  it UNDER the process/host env, then hand that back as the command's env.
 *  `vendo login` writes VENDO_API_KEY to `.env.local`, so a fresh shell after
 *  login must pick the key up from there with no manual `source` — while an
 *  already-set process VENDO_API_KEY still wins, exactly as init and the
 *  runtime resolve credentials. Reuses doctor's dotenv util (no hand-rolled
 *  parser). */
async function scopedEnv(dir: string, options: ConfigCommandOptions): Promise<Record<string, string | undefined>> {
  return mergeEnvOverDotEnv(await readDotEnvFallback(dir), (options.env ?? process.env) as NodeJS.ProcessEnv);
}

/** The same key resolution the runtime uses: an explicit `--key`, else
 *  VENDO_API_KEY from the environment (with `.env.local` merged in by
 *  scopedEnv). Returns the key or, when none is present, prints the `vendo
 *  login` remedy and null — so push/pull refuse up front instead of failing on
 *  the first service call with a bare "missing key". status stays lenient (it
 *  degrades to "unknown"). */
function requireKey(args: string[], options: ConfigCommandOptions, output: Output): string | null {
  const key = option(args, "--key") ?? (options.env ?? process.env).VENDO_API_KEY;
  if (key === undefined || key === "") {
    output.error("No VENDO_API_KEY found. Run `vendo login` to mint a project key (or pass --key).");
    return null;
  }
  return key;
}

interface PublishedConfig {
  version: string | null;
  config: Record<string, string> | null;
}

interface DraftConfig {
  draft?: Record<string, string> | null;
}

async function runStatus(args: string[], context: {
  fetcher: CloudFetcher;
  output: Output;
  options: ConfigCommandOptions;
}): Promise<number> {
  const { fetcher, output, options } = context;
  const dir = targetDir(args, options, false); // status takes no surface
  const scoped: ConfigCommandOptions = { ...options, env: await scopedEnv(dir, options) };
  // The published cloud doc (key-authed). A missing key / unreachable console
  // leaves cloud presence UNKNOWN rather than falsely reporting "unset".
  let published: Record<string, string> | null | undefined;
  try {
    const result = (await fetcher("/api/v1/config", keyOptions(args, scoped))) as PublishedConfig;
    published = result.config;
  } catch {
    published = undefined;
  }
  const rows: string[] = [];
  for (const surface of CONFIG_SURFACES) {
    const onDisk = await exists(vendoPath(dir, surface));
    const owner = onDisk
      ? "file"
      : published === undefined
        ? "unknown"
        : published?.[surface] !== undefined
          ? "cloud"
          : "unset";
    rows.push(`  ${surface.padEnd(18)} ${owner}`);
  }
  output.log("Config surface owners:\n" + rows.join("\n"));
  output.log("\n(A programmatic `explicit` override in createVendo wins over both file and cloud but is not visible to the CLI.)");
  output.log(`\n${OVERRIDES_ENABLEMENT_CAVEAT}`);
  return 0;
}

async function runPush(args: string[], context: {
  fetcher: CloudFetcher;
  output: Output;
  options: ConfigCommandOptions;
}): Promise<number> {
  const { fetcher, output, options } = context;
  const { surface, error } = surfaceArg(args);
  if (surface === undefined) {
    output.error(error!);
    return 1;
  }
  const dir = targetDir(args, options, true); // dir follows the surface
  const body = await readOptional(vendoPath(dir, surface));
  if (body === null) {
    output.error(`no ${join(".vendo", surface)} to push (nothing local to make cloud the source of)`);
    return 1;
  }
  const scoped: ConfigCommandOptions = { ...options, env: await scopedEnv(dir, options) };
  if (requireKey(args, scoped, output) === null) return 1;
  const keyOpts = keyOptions(args, scoped);
  // Read-merge-write against the KEY-authed draft plane (project from the key):
  // the draft PUT replaces the WHOLE draft, so merge this one surface onto the
  // current draft — never drop the others.
  const current = (await fetcher(DRAFT_PATH, keyOpts)) as DraftConfig;
  const nextDraft = { ...(current.draft ?? {}), [surface]: body };
  await fetcher(DRAFT_PATH, { ...keyOpts, method: "PUT", body: { draft: nextDraft } });
  output.log(`Pushed ${surface} to the config draft. Publish it from the console to make it live.`);
  // #557 — warn before the delete offer that a cloud overrides.json does not
  // disable tools at runtime, so removing the local file is not a tool-disable.
  if (surface === "overrides.json") output.log(OVERRIDES_ENABLEMENT_CAVEAT);
  const confirm = options.confirm ?? askYesNo;
  const remove = options.yes === true
    || args.includes("--yes")
    || (await confirm(`Delete the local ${join(".vendo", surface)} so cloud is the single source of truth?`, false));
  if (remove) {
    await rm(vendoPath(dir, surface), { force: true });
    output.log(`Removed ${join(".vendo", surface)} — cloud now owns this surface.`);
  }
  return 0;
}

async function runPull(args: string[], context: {
  fetcher: CloudFetcher;
  output: Output;
  options: ConfigCommandOptions;
}): Promise<number> {
  const { fetcher, output, options } = context;
  const { surface, error } = surfaceArg(args);
  if (surface === undefined) {
    output.error(error!);
    return 1;
  }
  const dir = targetDir(args, options, true); // dir follows the surface
  const wantDraft = args.includes("--draft");
  const scoped: ConfigCommandOptions = { ...options, env: await scopedEnv(dir, options) };
  if (requireKey(args, scoped, output) === null) return 1;
  let value: string | undefined;
  if (wantDraft) {
    // The KEY-authed draft plane (project from the key) — same credential as
    // the published read, no user session.
    const result = (await fetcher(DRAFT_PATH, keyOptions(args, scoped))) as DraftConfig;
    value = result.draft?.[surface];
  } else {
    const result = (await fetcher("/api/v1/config", keyOptions(args, scoped))) as PublishedConfig;
    value = result.config?.[surface];
  }
  if (value === undefined) {
    output.error(`${surface} is not ${wantDraft ? "in the draft" : "published"} — nothing to pull`);
    return 1;
  }
  await writeText(vendoPath(dir, surface), value);
  output.log(`Pulled ${surface} → ${join(".vendo", surface)} (${wantDraft ? "draft" : "published"}); it now resolves file-first.`);
  return 0;
}

export async function runConfig(args: string[], options: ConfigCommandOptions = {}): Promise<number> {
  const [command, ...rest] = args;
  const output = options.output ?? consoleOutput;
  const fetcher = options.fetcher ?? commandContext(options).fetcher;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    output.log(CONFIG_HELP);
    return command === undefined ? 1 : 0;
  }
  const context = { fetcher, output, options };
  try {
    if (command === "status") return await runStatus(rest, context);
    if (command === "push") return await runPush(rest, context);
    if (command === "pull") return await runPull(rest, context);
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  output.error(`Unknown config command: ${command}\n\n${CONFIG_HELP}`);
  return 1;
}
