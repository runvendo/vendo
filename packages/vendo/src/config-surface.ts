import type { CloudConfig } from "./cloud-config.js";

/** The per-surface config resolution seam (cse lane 3). Each `.vendo` content
 * surface is cloud-resolvable behind the locked adapter rule: resolution is,
 * per surface, explicit programmatic value → local `.vendo/<name>` file → cloud
 * PUBLISHED value for that key → unset. The FILE's existence is the switch; one
 * source of truth per surface, no bidirectional sync. Resolution is SYNC —
 * design-rules resolves through a thunk once per app generation — so the cloud
 * leg reads the cloudConfig stale-while-revalidate snapshot, never a blocking
 * fetch. No block reads the key: the cloudConfig adapter is created from
 * cloudKeyOptions AT the composition seam and passed in here. */

/** The five cloud-resolvable surfaces. Keys mirror the `.vendo` file names and
 * the console config doc keys. `tools.json`/`catalog.json` are NOT here: they
 * are generation inputs, not host-editable content surfaces. */
export const CONFIG_SURFACES = [
  "design-rules.md",
  "brief.md",
  "theme.json",
  "policy.json",
  "overrides.json",
] as const;

export type ConfigSurfaceName = (typeof CONFIG_SURFACES)[number];

export function isConfigSurface(name: string): name is ConfigSurfaceName {
  return (CONFIG_SURFACES as readonly string[]).includes(name);
}

/** Informational note for the overrides surface (#557, now landed): a
 * cloud-published overrides.json gates BOTH app GENERATION (field semantics +
 * the domain manifest) and tool ENABLEMENT (disabled / audience) at runtime.
 * Enablement resolves boot-once — the actions registry consults the published
 * overrides on the first request after boot — so pushing overrides.json to
 * cloud and deleting the local file DOES disable tools at runtime (it applies
 * on the next restart; app generation picks it up live per generation).
 * Surfaced by `config status`, `config push <overrides>`, and doctor. */
export const OVERRIDES_ENABLEMENT_NOTE =
  "Note: hosted overrides.json gates BOTH app generation (semantics/domains) and tool enablement "
  + "(disabled/audience) at runtime. Enablement resolves boot-once on the first request, so a console "
  + "publish (or deleting the local .vendo/overrides.json) applies on the next restart; app generation "
  + "picks it up live per generation.";

/** Which layer owns a surface's resolved value — surfaced by `vendo config
 * status` and doctor. */
export type ConfigSurfaceOwner = "explicit" | "file" | "cloud" | "unset";

export interface SelectConfigSurfaceInput {
  /** Programmatic override (e.g. config.theme). A blank/whitespace string does
   * not count — it falls through, matching the designRules `.trim()` posture. */
  explicit?: string | undefined;
  /** Reads the local `.vendo/<name>` body, or undefined when absent. Injected
   * (bound to the compose-time root) so this module stays fs-free and portable
   * and stays trivially unit-testable. */
  readFile: (name: ConfigSurfaceName) => string | undefined;
  /** The cloud config adapter, or undefined when no VENDO_API_KEY at the seam. */
  cloud?: CloudConfig | undefined;
}

export interface ResolvedConfigSurface {
  value: string | undefined;
  owner: ConfigSurfaceOwner;
}

export function selectConfigSurface(
  name: ConfigSurfaceName,
  input: SelectConfigSurfaceInput,
): ResolvedConfigSurface {
  const explicit = input.explicit?.trim();
  if (explicit) return { value: input.explicit, owner: "explicit" };

  const file = input.readFile(name);
  if (file !== undefined) return { value: file, owner: "file" };

  const cloudValue = input.cloud?.snapshot()?.config?.[name];
  if (cloudValue !== undefined) return { value: cloudValue, owner: "cloud" };

  return { value: undefined, owner: "unset" };
}
