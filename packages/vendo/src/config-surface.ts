/** The per-surface config resolution seam. Config resolves IN CODE, and only in
 * code: per surface, explicit programmatic value → local `.vendo/<name>` file →
 * unset. The FILE's existence is the switch; one source of truth per surface,
 * no bidirectional sync and no remote layer — a keyed runtime REPORTS what it
 * resolved (config-report.ts) and the console never answers back. Resolution is
 * SYNC: design-rules resolves through a thunk once per app generation. */

/** The five content surfaces. Keys mirror the `.vendo` file names.
 * `tools.json`/`catalog.json` are NOT here: they are generation inputs, not
 * host-editable content surfaces. */
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

/** Informational note for the overrides surface: `.vendo/overrides.json` gates
 * BOTH app GENERATION (field semantics) and tool ENABLEMENT (disabled /
 * audience) at runtime. Enablement resolves boot-once — the actions registry
 * consults it on the first request after boot — so an edit applies on the next
 * restart; app generation picks it up live per generation. Surfaced by
 * `config status` and doctor. */
export const OVERRIDES_ENABLEMENT_NOTE =
  "Note: overrides.json gates BOTH app generation (field semantics) and tool enablement "
  + "(disabled/audience) at runtime. Enablement resolves boot-once on the first request, so an edit "
  + "applies on the next restart; app generation picks it up live per generation.";

/** Which layer owns a surface's resolved value — surfaced by `vendo config
 * status` and doctor. */
export type ConfigSurfaceOwner = "explicit" | "file" | "unset";

export interface SelectConfigSurfaceInput {
  /** Programmatic override (e.g. config.theme). A blank/whitespace string does
   * not count — it falls through, matching the designRules `.trim()` posture. */
  explicit?: string | undefined;
  /** Reads the local `.vendo/<name>` body, or undefined when absent. Injected
   * (bound to the compose-time root) so this module stays fs-free and portable
   * and stays trivially unit-testable. */
  readFile: (name: ConfigSurfaceName) => string | undefined;
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

  return { value: undefined, owner: "unset" };
}
