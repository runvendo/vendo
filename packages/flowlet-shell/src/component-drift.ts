/** Registry versioning for saved flowlets (ENG-186).
 *
 *  A saved flowlet outlives the host-component registry it was built against:
 *  the host renames a component and the tree degrades to an "Unknown component"
 *  notice; the host changes a props schema and the node degrades to an
 *  invalid-props placeholder. Both are contained — but silent. These helpers
 *  make the drift DETECTABLE: `stampHostComponents` records name → version at
 *  save time, `diffHostComponents` compares that stamp against the live
 *  registry at reopen so the shell can say *why* a view degraded.
 *
 *  Versions are host-declared (`hostComponent(..., { version })`), bumped on
 *  breaking changes; unset means "1". No stamp (a pre-versioning record) diffs
 *  as clean — old saves must not start warning retroactively.
 */
import {
  isGeneratedNode,
  type GeneratedPayload,
  type RegisteredComponent,
  type UINode,
} from "@flowlet/core";

/** The implied version of a registry entry that declares none. */
export const DEFAULT_COMPONENT_VERSION = "1";

/**
 * Record which host components a view uses, at which registry version.
 * Returns undefined for non-generated nodes or trees with no host nodes —
 * records stay stamp-free rather than carrying an empty object.
 */
export function stampHostComponents(
  node: UINode,
  components: readonly RegisteredComponent[],
): Record<string, string> | undefined {
  if (!isGeneratedNode(node)) return undefined;
  const byName = new Map(components.map((c) => [c.name, c]));
  const stamp: Record<string, string> = {};
  for (const genNode of (node.payload as GeneratedPayload).nodes) {
    if (genNode.source !== "host") continue;
    stamp[genNode.component] =
      byName.get(genNode.component)?.version ?? DEFAULT_COMPONENT_VERSION;
  }
  return Object.keys(stamp).length > 0 ? stamp : undefined;
}

export interface ComponentDrift {
  /** Stamped names no longer in the registry (renamed or removed). */
  missing: string[];
  /** Stamped names whose registry version moved since the save. */
  changed: string[];
}

export const NO_DRIFT: ComponentDrift = { missing: [], changed: [] };

/** Compare a saved stamp against the live registry. */
export function diffHostComponents(
  stamp: Record<string, string> | undefined,
  components: readonly RegisteredComponent[],
): ComponentDrift {
  if (stamp === undefined) return NO_DRIFT;
  const byName = new Map(components.map((c) => [c.name, c]));
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [name, savedVersion] of Object.entries(stamp)) {
    const current = byName.get(name);
    if (current === undefined) missing.push(name);
    else if ((current.version ?? DEFAULT_COMPONENT_VERSION) !== savedVersion) changed.push(name);
  }
  return missing.length === 0 && changed.length === 0 ? NO_DRIFT : { missing, changed };
}
