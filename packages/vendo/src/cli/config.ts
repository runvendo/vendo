import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_SURFACES, isConfigSurface, OVERRIDES_ENABLEMENT_CAVEAT, type ConfigSurfaceName } from "../config-surface.js";
import { option } from "./cloud/args.js";
import type { CloudFetchOptions } from "./cloud/client.js";
import {
  commandContext,
  resolveProjectId,
  userOptions,
  type CloudCommandOptions,
  type CloudFetcher,
} from "./cloud/command.js";
import { askYesNo, consoleOutput, exists, readOptional, writeText, type Output } from "./shared.js";

/** `vendo config` (cse lane 3) — move a `.vendo` content surface between local
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
 * The console DRAFT plane is session-authed (`vendo login`), so push and
 * `pull --draft` resolve a project (org → project, or `--project <id>`) and use
 * the user session; the PUBLISHED read is key-authed (the same call the runtime
 * makes). `explicit` (a programmatic override in createVendo) is not visible to
 * the CLI, so `config status` reports only file / cloud / unset. */

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

Surfaces: ${CONFIG_SURFACES.join(", ")}

Options:
  --draft            Pull only: pull the working draft instead of the published value
  --yes              Push only: delete the local file without asking (cloud becomes the source)
  --project <id>     Console draft: the project (omit only when the org has one project)
  --org <id>         Console draft: the organization (omit only when you have one org)
  --key <key>        Published read: override VENDO_API_KEY
  --api-url <url>    Override VENDO_CLOUD_URL / https://console.vendo.run
`;

function vendoPath(targetDir: string, surface: ConfigSurfaceName): string {
  return join(targetDir, ".vendo", surface);
}

function surfaceArg(args: string[]): { surface?: ConfigSurfaceName; error?: string } {
  const positional = args.find((value) => !value.startsWith("--"));
  if (positional === undefined) return { error: "a surface is required" };
  if (!isConfigSurface(positional)) {
    return { error: `unknown surface ${JSON.stringify(positional)}. Known surfaces: ${CONFIG_SURFACES.join(", ")}` };
  }
  return { surface: positional };
}

/** The positional after the surface, if any, is the project dir. */
function targetDir(args: string[], options: ConfigCommandOptions): string {
  if (options.targetDir !== undefined) return options.targetDir;
  const positionals = args.filter((value) => !value.startsWith("--"));
  // positionals[0] is the surface for push/pull; the dir is the next one.
  return positionals[1] ?? process.cwd();
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
  const dir = targetDir(args, options);
  // The published cloud doc (key-authed). A missing key / unreachable console
  // leaves cloud presence UNKNOWN rather than falsely reporting "unset".
  let published: Record<string, string> | null | undefined;
  try {
    const result = (await fetcher("/api/v1/config", keyOptions(args, options))) as PublishedConfig;
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
  const dir = targetDir(args, options);
  const body = await readOptional(vendoPath(dir, surface));
  if (body === null) {
    output.error(`no ${join(".vendo", surface)} to push (nothing local to make cloud the source of)`);
    return 1;
  }
  const commandCtx = commandContext(options);
  const projectId = await resolveProjectId(args, commandCtx);
  const userOpts = userOptions(args, commandCtx);
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/config`;
  // Read-merge-write: the draft PUT replaces the WHOLE draft, so merge this one
  // surface onto the current draft — never drop the others.
  const current = (await fetcher(path, userOpts)) as DraftConfig;
  const nextDraft = { ...(current.draft ?? {}), [surface]: body };
  await fetcher(path, { ...userOpts, method: "PUT", body: { draft: nextDraft } });
  output.log(`Pushed ${surface} to the ${projectId} config draft. Publish it from the console to make it live.`);
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
  const dir = targetDir(args, options);
  const wantDraft = args.includes("--draft");
  let value: string | undefined;
  if (wantDraft) {
    const commandCtx = commandContext(options);
    const projectId = await resolveProjectId(args, commandCtx);
    const result = (await fetcher(
      `/api/v1/projects/${encodeURIComponent(projectId)}/config`,
      userOptions(args, commandCtx),
    )) as DraftConfig;
    value = result.draft?.[surface];
  } else {
    const result = (await fetcher("/api/v1/config", keyOptions(args, options))) as PublishedConfig;
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
