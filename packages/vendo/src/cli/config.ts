import { join } from "node:path";
import { CONFIG_SURFACES, OVERRIDES_ENABLEMENT_NOTE, type ConfigSurfaceName } from "../config-surface.js";
import { positionals } from "./cloud/args.js";
import { consoleOutput, exists, type Output } from "./shared.js";

/** `vendo config` — report which layer owns each `.vendo` content surface.
 *
 * The seam this reads (selectConfigSurface): per surface, resolution is a value
 * passed in code → the local `.vendo/<name>` file → unset. That is the whole
 * ladder; nothing remote participates, so this command makes no network call
 * and needs no credential. A keyed runtime REPORTS what it resolved
 * (config-report.ts), one way — there is nothing to pull back.
 *
 * A value passed in code is not visible to the CLI, so `status` reports only
 * file / unset. */

export interface ConfigCommandOptions {
  targetDir?: string;
  output?: Output;
}

const CONFIG_HELP = `vendo config — show which layer owns each .vendo config surface

Usage:
  vendo config status [dir]              Show each surface's owner (file / unset)

Config resolves in code: a value passed to createVendo wins, then
.vendo/<surface>, then unset. This command reads local disk only — no
credential, no network.

Surfaces: ${CONFIG_SURFACES.join(", ")}
`;

function vendoPath(targetDir: string, surface: ConfigSurfaceName): string {
  return join(targetDir, ".vendo", surface);
}

async function runStatus(args: string[], context: {
  output: Output;
  options: ConfigCommandOptions;
}): Promise<number> {
  const { output, options } = context;
  const dir = options.targetDir ?? positionals(args, [])[0] ?? process.cwd();
  const rows = await Promise.all(CONFIG_SURFACES.map(async (surface) =>
    `  ${surface.padEnd(18)} ${(await exists(vendoPath(dir, surface))) ? "file" : "unset"}`));
  output.log("Config surface owners:\n" + rows.join("\n"));
  output.log("\n(A value passed to createVendo wins over the file but is not visible to the CLI.)");
  output.log(`\n${OVERRIDES_ENABLEMENT_NOTE}`);
  return 0;
}

export async function runConfig(args: string[], options: ConfigCommandOptions = {}): Promise<number> {
  const [command, ...rest] = args;
  const output = options.output ?? consoleOutput;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    output.log(CONFIG_HELP);
    return command === undefined ? 1 : 0;
  }
  if (command === "status") return await runStatus(rest, { output, options });
  output.error(`Unknown config command: ${command}\n\n${CONFIG_HELP}`);
  return 1;
}
