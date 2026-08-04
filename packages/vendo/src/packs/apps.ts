/**
 * `apps()` — app generation as the first pack, not a subsystem (architecture §6).
 *
 * It rides the same public slots a third party gets: its tools go in through
 * `Pack.tools`, its skill through `Pack.skills`. There is no privileged internal
 * API, which is the whole point of expressing it this way — if the pack
 * interface were not enough for us, it would not be enough for anyone.
 *
 * What it does NOT contribute, and why:
 *
 * - **checks** — the floor's fact checks are the floor, not a contribution: they
 *   are bound per build to the catalog and tool shapes that build measured
 *   against, which do not exist at boot. §7 lists host checks (plugged via
 *   packs) as a separate thing from validate and review, and that is honest.
 * - **components** — the host's components arrive through `catalog`, and the
 *   renderer is client-side. A pack's `components` slot is for components a pack
 *   brings with it.
 */
import { agentToolDescriptors, buildingAppsSkill } from "@vendoai/apps";
import type { Pack, ToolDefinition, ToolRegistry } from "@vendoai/core";
import { definePack } from "./define.js";
import { toolsFromRegistry } from "./from-registry.js";
import type { PackContext } from "./merge.js";

export const APPS_PACK_NAME = "apps";

/** The tools the apps pack declares — the shipped `vendo_apps_*` set, unchanged,
 *  re-expressed as pack tool definitions. */
export const appsPackTools = (registry: () => ToolRegistry): ToolDefinition[] =>
  toolsFromRegistry(registry, agentToolDescriptors);

/**
 * The apps pack. A function of the boot context because its tools act through
 * the apps runtime, which only exists once the server is composed — the same way
 * a harness that needs host dependencies is a plain factory (build contract §1).
 */
export const apps = () => (context: PackContext): Pack => definePack({
  name: APPS_PACK_NAME,
  tools: appsPackTools(() => context.apps().agentTools()),
  skills: [buildingAppsSkill],
});
