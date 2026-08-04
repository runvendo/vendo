/**
 * What composition says out loud about the configured packs.
 *
 * Both of these are pure functions of what boot already knows, so the messages
 * are testable on their own rather than only observable as console noise from a
 * booted server.
 */
import { VendoError } from "@vendoai/core";
import { APPS_PACK_NAME } from "./apps.js";

/**
 * The `.vendo` directory a configured `profileDir` means — the SAME rule the tool
 * registry's own reader uses (`readOptionalVendoJson` in @vendoai/actions):
 * `dir` may be the host root, in which case `.vendo` is inside it, or the
 * `.vendo` directory itself.
 *
 * Getting this wrong is not a wrong answer, it is NO answer: a gate that always
 * appended `/.vendo/` read nothing at all when `profileDir` pointed at `.vendo`,
 * so the boot check silently passed and the collision reverted to the
 * first-request failure the check exists to prevent.
 *
 * String-only on purpose (no `node:path`): this file is reachable from edge
 * bundles, and the comparison is exact enough — a directory merely ending in the
 * letters "vendo" is not `.vendo`.
 */
export const vendoDirOf = (dir: string): string => {
  const withoutTrailingSlash = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  const last = withoutTrailingSlash.slice(withoutTrailingSlash.lastIndexOf("/") + 1);
  return last === ".vendo" ? dir : `${withoutTrailingSlash}/.vendo`;
};

/**
 * The host tool names in a `tools.json` document.
 *
 * Best-effort by design: a malformed or absent file yields no names. The registry
 * is the real parser and reports properly on a bad file; this gate exists to say
 * something useful early, never to become a second validator that could refuse a
 * boot the registry would have accepted.
 */
export const hostToolNamesIn = (raw: string | undefined): string[] => {
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const tools = (parsed as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    const name = (tool as { name?: unknown } | null)?.name;
    return typeof name === "string" ? [name] : [];
  });
};

/**
 * A pack claiming a tool name the HOST's own tools already own.
 *
 * The registry refuses this collision on its own — it throws `conflict` — but
 * only when it first loads, on some later request, and its message names just
 * the second arrival ("from added registry"): nothing says which pack, or what
 * it hit. This is the boot-time half, and it throws, so the deployment never
 * starts in a state where every tool call is going to fail.
 *
 * It compares against the host tool names composition already has WITHOUT doing
 * any I/O. Connector tools are not here on purpose: knowing them means a network
 * round trip, and making `createVendo` reach the network to compose would be a
 * far worse trade than leaving that rarer collision to the registry.
 */
export const hostPackToolCollision = (
  toolOwners: ReadonlyMap<string, string>,
  hostToolNames: readonly string[],
): VendoError | undefined => {
  for (const name of hostToolNames) {
    const pack = toolOwners.get(name);
    if (pack !== undefined) {
      return new VendoError(
        "conflict",
        // ONE remedy, and it is the one that works. A host cannot rename its own
        // tool through `.vendo/overrides.json` (ToolOverride carries no `name`),
        // and disabling it does not help either — a disabled tool still reserves
        // its name in the registry, so the collision would outlive the fix.
        `the pack "${pack}" declares the tool "${name}", but this deployment's own host tools already claim that name. Tool names are global as authored — nothing is auto-prefixed, because a skill body naming a tool is copied verbatim — so rename it in the pack.`,
      );
    }
  }
  return undefined;
};

/**
 * An explicit `packs:` list with no apps pack in it.
 *
 * App generation is what the agent is FOR, and dropping it is silent otherwise:
 * the agent simply answers that it cannot build apps, with nothing anywhere
 * saying why. A warning rather than an error, because running without it is a
 * legitimate (if unusual) choice — a host embedding only its own pack.
 */
export const missingAppsPackWarning = (configured: readonly string[] | undefined): string | undefined => {
  if (configured === undefined || configured.includes(APPS_PACK_NAME)) return undefined;
  const listed = configured.length === 0 ? "(none)" : configured.join(", ");
  return `[vendo] createVendo({ packs }) is set to [${listed}] and does not include apps(), so this agent cannot build apps at all — the app tools, the building-apps skill, and the app checks are all absent. Add apps() to the list if that was not deliberate: packs: [apps(), ...].`;
};
