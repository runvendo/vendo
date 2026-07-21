import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { EngineDeps, EngineJob, EngineMessage } from "./types.js";

/**
 * The one file in this package allowed to touch the real
 * `@anthropic-ai/claude-agent-sdk`. Mirrors the read-only isolation posture
 * of the sibling in-process harness (packages/vendo's `claude-harness.ts`):
 * settings isolated, tools restricted to Read/Glob/Grep, no shell/write/web
 * surface. This package has no ExtractionHarness/init concept of its own —
 * it only knows `{instructions, root}` in, final text out.
 */

const ALLOWED_TOOLS = ["Read", "Glob", "Grep"];
const DISALLOWED_TOOLS = [
  "Bash", "Write", "Edit", "WebFetch", "WebSearch", "Task",
  "TodoWrite", "NotebookEdit", "KillShell", "BashOutput", "ExitPlanMode",
];
// Generic jobs can be more open-ended than a single extraction stage; same
// order of magnitude as the sibling harness's cap (40) with headroom.
const MAX_TURNS = 60;

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** The subset of a PermissionResult (the SDK's canUseTool return union) this
 *  file produces. Local shape for the same reason as SdkModule below: the
 *  real type lives behind the dynamic import. */
type ConfinementVerdict =
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

/** Realpath of the deepest existing ancestor, with the not-yet-existing tail
 *  re-appended — so a symlink anywhere on the path is resolved to its real
 *  target before containment is judged, and a path that does not exist yet
 *  still gets an honest verdict from its existing parent. */
function resolveThroughSymlinks(target: string): string {
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

/** The pure(-ish: it reads the filesystem for realpath, never writes) heart
 *  of the read confinement, exported for direct unit tests. Denies any
 *  Read/Glob/Grep whose path input — absolute, relative, `..`-climbing, or
 *  reached through a symlink — resolves outside `rootRealpath` (which must
 *  already be a realpath, see createSdkQuery). Everything else is allowed:
 *  the session's `tools` option already bounds the tool set to the read-only
 *  three, so this callback is a path check, not a second allowlist. */
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
          `${toolName} of ${candidate} denied: it resolves outside the engine job root (${rootRealpath}). `
          + "This engine only reads within the directory it was given.",
      };
    }
  }
  return { behavior: "allow", updatedInput: input };
}

/** Loosely-typed shape of the bits of the real SDK module this file uses.
 *  Not the full official types: the SDK's message union has ~40 variants
 *  and this file only ever branches on 2 of them (see `adapt` below); a
 *  narrow local shape is both enough and immune to upstream additions. */
interface SdkModule {
  query(params: { prompt: string; options: Record<string, unknown> }): AsyncIterable<Record<string, unknown>>;
}

/** Dynamic, not static: a static `import` would resolve this package the
 *  moment any file in @vendoai/engine is imported — including by every unit
 *  test and by `tsc --noEmit`, which must never require the SDK's ~245MB
 *  platform binary to be present. Only the real run path (this function,
 *  called from createSdkQuery's returned generator) ever loads it. */
async function loadSdk(): Promise<SdkModule> {
  return (await import(SDK_PACKAGE)) as unknown as SdkModule;
}

/** Projects the raw SDK message stream onto EngineMessage. Assistant text
 *  and tool_use blocks become "progress" (destined for stderr); the
 *  terminal `result` message becomes "success" or "failure" and ends the
 *  generator — the SDK's own contract is that `result` is always last.
 *
 *  Exported (only) so unit tests can exercise this projection directly
 *  against hand-built raw messages, without ever loading the real SDK —
 *  `loadSdk`/`createSdkQuery`'s own dynamic import is the one thing here
 *  that genuinely needs a live credential, and is covered by the gated
 *  engine.live.test.ts instead. */
export async function* adapt(stream: AsyncIterable<Record<string, unknown>>): AsyncGenerator<EngineMessage> {
  for await (const message of stream) {
    const type = message["type"];
    if (type === "assistant") {
      const content = (message["message"] as { content?: Array<Record<string, unknown>> } | undefined)?.content;
      for (const block of content ?? []) {
        if (block["type"] === "text" && typeof block["text"] === "string" && block["text"].length > 0) {
          yield { kind: "progress", text: block["text"] };
        } else if (block["type"] === "tool_use" && typeof block["name"] === "string") {
          const input = block["input"] as { file_path?: unknown; pattern?: unknown } | undefined;
          const target = typeof input?.file_path === "string" ? input.file_path
            : typeof input?.pattern === "string" ? input.pattern : "";
          yield { kind: "progress", text: `${block["name"]} ${target}`.trim() };
        }
      }
    } else if (type === "result") {
      if (message["subtype"] === "success" && typeof message["result"] === "string") {
        yield { kind: "success", text: message["result"] };
      } else {
        const errors = message["errors"];
        yield {
          kind: "failure",
          errors: Array.isArray(errors) && errors.every((e) => typeof e === "string")
            ? errors
            : [`engine ${String(message["subtype"] ?? "error")}`],
        };
      }
      return;
    }
  }
}

/** Builds the real EngineDeps["query"]. Isolation notes:
 *  - `settingSources: []` — never load the dev's ~/.claude or project
 *    settings/hooks (the whole point of running this as a separate,
 *    npx-fetched process rather than the dev's own `claude` session).
 *  - `tools` restricts the tool set to the read-only three;
 *    `disallowedTools` is belt-and-suspenders against upstream additions to
 *    the default tool set.
 *  - `canUseTool` (not a blanket `allowedTools` auto-allow, which would
 *    grant Read/Glob/Grep on ANY path and never consult a callback) answers
 *    every permission ask programmatically, so a headless run still never
 *    blocks on a prompt nobody can answer — but reads outside the job root
 *    are DENIED. A hostile repo's content can prompt-inject the agent into
 *    `Read /Users/dev/.aws/credentials`; the package contract ("tool policy
 *    rooted at the given directory") means that must fail, not ship the
 *    dev's unrelated local files to the model. Containment is judged
 *    against the realpath of job.root so symlinks can't smuggle either side.
 *  - `persistSession: false` — one-shot job, no ~/.claude/projects/
 *    transcript left behind on whatever machine runs this.
 *  - No `env` option is set: per the SDK's own default, omitting it means
 *    the subprocess inherits `process.env` verbatim — exactly the "pass
 *    credentials through untouched" contract (ANTHROPIC_API_KEY or
 *    ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_CUSTOM_HEADERS). */
export function createSdkQuery(): EngineDeps["query"] {
  return async function* query(job: EngineJob): AsyncGenerator<EngineMessage> {
    const sdk = await loadSdk();
    // Realpath once up front: if job.root is itself reached through a
    // symlink (macOS /tmp -> /private/tmp), tool paths resolve to the real
    // side and a string-prefix check against the raw root would misjudge.
    const rootRealpath = realpathSync(job.root);
    const stream = sdk.query({
      prompt: job.instructions,
      options: {
        cwd: job.root,
        settingSources: [],
        tools: ALLOWED_TOOLS,
        disallowedTools: DISALLOWED_TOOLS,
        permissionMode: "default",
        canUseTool: async (toolName: string, input: Record<string, unknown>) =>
          confineToolToRoot(toolName, input, rootRealpath),
        maxTurns: MAX_TURNS,
        persistSession: false,
      },
    });
    yield* adapt(stream);
  };
}
