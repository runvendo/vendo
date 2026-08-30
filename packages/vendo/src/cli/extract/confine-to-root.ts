import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Read confinement for the extraction ladder. Every rung drives a coding agent
 * with the read-only three (Read/Glob/Grep) over the host root; a blanket
 * auto-allow grants those tools on ANY path, so a hostile repo's content can
 * prompt-inject the agent into `Read ~/.aws/credentials`. The ladder's contract
 * is "read-only tools rooted at the host directory", which means such a read
 * must FAIL, not ship the dev's unrelated local files to the model.
 *
 * It lives at the ladder level, not inside one rung, so the guarantee outlives
 * whichever rung happens to enforce it. Two forms, because the rungs enforce
 * it in two different places: `confineToolToRoot` is the in-process decision
 * the Agent SDK rung wires as its `canUseTool` callback, and
 * `rootScopedToolRules` is the same confinement expressed as the permission
 * rules the two CLI rungs pass on argv — a subprocess has no callback to hand
 * it.
 */

/** The subset of the SDK's `canUseTool` return union this file produces. The
 *  real type lives behind claude-harness.ts's dynamic import of the SDK. */
export type ConfinementVerdict =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** The path-shaped inputs of the three allowed read-only tools. A Glob
 *  `pattern` can itself be an absolute path (or climb with `..`), so its
 *  static, glob-free base directory is confined too — not just the `path`
 *  search-root field. Grep's `pattern` is a regex, never a path. */
function candidatePaths(toolName: string, input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) paths.push(value);
  };
  if (toolName === "Read") push(input["file_path"]);
  if (toolName === "Grep") push(input["path"]);
  if (toolName === "Glob") {
    push(input["path"]);
    const pattern = input["pattern"];
    if (typeof pattern === "string") {
      // Static prefix: everything before the first glob metacharacter,
      // trimmed back to the last full path segment.
      const magic = pattern.search(/[*?[{]/);
      const prefix = magic === -1 ? pattern : pattern.slice(0, magic);
      const cut = prefix.lastIndexOf("/");
      // cut 0 means a filesystem-root pattern like "/*" — the base is "/".
      if (cut === 0) push(sep);
      else if (cut > 0) push(prefix.slice(0, cut));
    }
  }
  return paths;
}

/**
 * Realpath of the deepest existing ancestor, with the not-yet-existing tail
 * re-appended — so a symlink anywhere on the path is resolved to its real
 * target before containment is judged, and a path that does not exist yet
 * still gets an honest verdict from its existing parent.
 *
 * Exported because the ROOT needs the same normalization before it can be
 * compared against: on macOS `/tmp` is a symlink to `/private/tmp`, so tool
 * paths resolve to the real side and a string-prefix check against the raw
 * root would misjudge every one of them.
 */
export function resolveThroughSymlinks(target: string): string {
  let current = target;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return target; // hit the filesystem root; nothing existed
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * The pure(-ish: it reads the filesystem for realpath, never writes) heart of
 * the read confinement. Denies any Read/Glob/Grep whose path input — absolute,
 * relative, `..`-climbing, or reached through a symlink — resolves outside
 * `rootRealpath` (which must already be a realpath, see resolveThroughSymlinks).
 * Everything else is allowed: the session's `tools` option already bounds the
 * tool set to the read-only three, so this callback is a path check, not a
 * second allowlist.
 */
export function confineToolToRoot(
  toolName: string,
  input: Record<string, unknown>,
  rootRealpath: string,
): ConfinementVerdict {
  for (const candidate of candidatePaths(toolName, input)) {
    const resolved = resolveThroughSymlinks(resolve(rootRealpath, candidate));
    if (resolved !== rootRealpath && !resolved.startsWith(rootRealpath + sep)) {
      return {
        behavior: "deny",
        message:
          `${toolName} of ${candidate} denied: it resolves outside the extraction root (${rootRealpath}). `
          + "Init only reads within the directory it was pointed at.",
      };
    }
  }
  return { behavior: "allow", updatedInput: input };
}

/**
 * The CLI rungs' form of the same confinement: `--allowedTools` rules scoped
 * to the root, never the bare tool names. A bare `Read` auto-allows Read on
 * ANY path; `Read(//abs/root/**)` (the `//` anchor is the CLI's own syntax for
 * a filesystem-absolute path) allows it only inside the root, and anything
 * else falls back to a permission prompt that headless mode cannot answer —
 * so it is denied.
 *
 * The CLI matches an allow rule against BOTH the path the model supplied and
 * the path it resolves to, which is what makes this a real confinement rather
 * than a string-prefix check: a `../` climb and an in-root symlink pointing
 * outside are each denied (verified against @anthropic-ai/claude-code 2.1.224
 * — see confine-to-root.live.test.ts). That same both-sides matching is why
 * the realpath of the root gets its own rule when it differs from the root as
 * given: on macOS `/tmp` is a symlink to `/private/tmp`, so the supplied side
 * is the symlinked form and the resolved side is the realpath, and naming only
 * one of them would deny every in-root read. Naming the same directory twice
 * does not widen the confinement.
 */
export function rootScopedToolRules(root: string): string[] {
  const asGiven = resolve(root);
  const real = resolveThroughSymlinks(asGiven);
  const dirs = real === asGiven ? [asGiven] : [asGiven, real];
  return dirs.flatMap((dir) => ["Read", "Glob", "Grep"].map((tool) => `${tool}(/${dir}/**)`));
}
