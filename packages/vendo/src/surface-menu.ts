/**
 * The composition seam's cache for a resolved per-surface tool menu
 * (`.vendo/overrides.json` `surfaces.*`, via `ActionsRegistry.surfaceMenu`).
 *
 * A menu is boot configuration, so a SUCCESSFUL resolution is cached for the
 * process. A FAILED one never is: caching a rejection would freeze the surface
 * into whatever the failure degraded to (here, unrestricted) for the life of
 * the process, long after the cause was fixed. A failure also has to be loud —
 * silently serving an unrestricted surface because a file could not be read is
 * exactly the kind of quiet wrong answer that ships.
 *
 * Degrading to unrestricted (rather than empty) is deliberate: a menu is
 * curation, not a permission boundary, so failing to read one must not silently
 * disarm a product's agent. The guard, `disabled`, and audience exclusions are
 * what actually restrict, and none of them run through here.
 */
export function memoizedSurfaceMenu(
  resolve: () => Promise<string[] | undefined>,
  warn: (message: string) => void = (message) => console.warn(message),
): () => Promise<Set<string> | undefined> {
  let cached: Promise<Set<string> | undefined> | undefined;
  return () => {
    if (cached !== undefined) return cached;
    const attempt = resolve()
      .then((names) => (names === undefined ? undefined : new Set(names)))
      .catch((error: unknown) => {
        cached = undefined;
        warn(
          "[vendo] could not resolve the agent's surfaces menu from .vendo/overrides.json; "
          + `serving the full tool surface this turn: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      });
    cached = attempt;
    return attempt;
  };
}
