/**
 * The `.vendo/` surface readers the composition uses at compose time.
 *
 * Moved out of server.ts with the composition they serve; every one is a pure,
 * fail-soft read, and nothing here reaches the network.
 */
import type { ExtractedTool } from "@vendoai/actions";
import { seedBaselineSchema, type SeedBaseline } from "@vendoai/apps";
import {
  type ToolDefinition,
} from "@vendoai/core";
import {
  vendoThemeSchema,
  type VendoTheme,
} from "@vendoai/apps/contract";
import { hostToolNamesIn, vendoDirOf } from "./capability/index.js";
import type { CreateVendoConfig } from "./types.js";

/** 09 §4 — the .vendo/ files feeding the generation seat, read fail-soft (the
    composition works without them; on non-Node runtimes they just stay unset).
    Reads `node:fs` through the runtime built-in accessor so this module carries
    NO static Node import and still loads/bundles for edge/Worker targets.

    `root` is a `profileDir`, so it goes through `vendoDirOf` — it may be the
    host root or the `.vendo` directory itself, exactly like the actions
    registry's reader. Appending unconditionally reads `.vendo/.vendo/…`, which
    fail-soft turns into silence: theme, brief, catalog and knowledge all
    vanish with no error. */
export function dotVendoFile(name: string, root?: string): string | undefined {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const fs = proc?.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined;
    if (fs === undefined) return undefined;
    return fs.readFileSync(`${vendoDirOf(root ?? ".")}/${name}`, "utf8");
  } catch {
    return undefined;
  }
}

/** A synchronous, throw-free read of one file, for the compose-time gates. */
export function readFileSyncOrUndefined(path: string): string | undefined {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const fs = proc?.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined;
    if (fs === undefined) return undefined;
    return fs.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The host's own tool names, as far as composition can know them without doing
 * any I/O beyond one file read: the in-memory `profile.tools` piece, else
 * `tools.json` from the SAME directory the tool registry resolves it from.
 *
 * `vendoDirOf` is the registry's own rule (`profileDir` may be the host root or
 * the `.vendo` directory itself). Using anything else here made the gate read a
 * different file — or no file — and a gate that reads nothing passes everything.
 */
export function hostToolNames(config: CreateVendoConfig): string[] {
  const inMemory = selectHostTools(config);
  if (inMemory !== undefined) return inMemory.map((tool) => tool.name);
  return hostToolNamesIn(readFileSyncOrUndefined(`${vendoDirOf(config.profileDir ?? ".")}/tools.json`));
}

/**
 * ADAPTER RULE, host-tool declarations (§10's `tools:` slot): the ONE place the
 * in-memory host-tool list is chosen, so the compose-time gate, the actions
 * registry and the development-capture baseline can never read different sets.
 *
 * `tools:` beats the deprecated `profile.tools` rather than the other way round.
 * The `apps.designRules` precedent — longer-standing knob wins — is about two
 * knobs of equal standing; this is a slot and its own former spelling, and a host
 * who adds the documented slot expects it to take effect.
 */
export function selectHostTools(config: CreateVendoConfig): ExtractedTool[] | undefined {
  if (config.tools === undefined) return config.profile?.tools;
  const declared = config.tools.filter(isDeclaration);
  // A `tools:` carrying ONLY executables did not supply a declaration list, so
  // it must not shadow `profile.tools` or the `tools.json` read with an empty
  // set — that silently erased every host tool AND blinded the boot collision
  // gate, which then read no file and passed everything. An explicitly empty
  // `tools: []` still means "no host tools", exactly as it always did.
  if (declared.length === 0 && config.tools.length > 0) return config.profile?.tools;
  return declared;
}

/** The two shapes `tools:` accepts, told apart by the one thing only an
 *  executable tool has. A declaration carries a `binding` the registry executes
 *  through; a definition carries the function itself. */
const isDeclaration = (tool: ExtractedTool | ToolDefinition): tool is ExtractedTool =>
  typeof (tool as ToolDefinition).execute !== "function";

/** The executable half of `tools:` — what joins the one registry as a
 *  contribution rather than as a `.vendo` declaration. */
export function hostToolDefinitions(config: CreateVendoConfig): ToolDefinition[] {
  return (config.tools ?? []).filter((tool): tool is ToolDefinition => !isDeclaration(tool));
}

/** The compose-time project root for .vendo reads that happen LATER (the
    per-generation design-rules read): pinning it keeps a host that chdirs
    mid-run reading the same project every other .vendo input came from. */
export function dotVendoRoot(): string | undefined {
  try {
    return (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.();
  } catch {
    return undefined;
  }
}

/** Parse a theme surface body (from `.vendo/theme.json` or, when it later gains
    a cloud leg, the published doc). Malformed → undefined, same fail-soft
    stance as the rest of the .vendo readers. */
export function parseVendoTheme(raw: string | undefined): VendoTheme | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = vendoThemeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 06-apps §8 — load sync-captured host source into the composition. Invalid
    files are warned and skipped so one bad slot cannot crash the host; an
    absent directory is the normal zero-remixable-components case. */
export function dotVendoSeedBaselines(root?: string): SeedBaseline[] {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fs = proc?.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined;
  if (fs === undefined) return [];
  const directory = `${vendoDirOf(root ?? ".")}/remixable`;
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    console.warn(`[vendo] could not read ${directory}; pin baselines were skipped`);
    return [];
  }

  const baselines: SeedBaseline[] = [];
  const slots = new Set<string>();
  for (const name of names) {
    const file = `${directory}/${name}`;
    try {
      const parsed = seedBaselineSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (slots.has(parsed.slot)) {
        console.warn(`[vendo] duplicate pin baseline slot ${parsed.slot} in ${file}; file was skipped`);
        continue;
      }
      slots.add(parsed.slot);
      baselines.push(parsed);
    } catch {
      console.warn(`[vendo] invalid pin baseline ${file}; file was skipped`);
    }
  }
  return baselines;
}
