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
 *  - `tools`/`allowedTools` restrict AND auto-allow the read-only set so a
 *    headless run never blocks on a permission prompt nobody can answer;
 *    `disallowedTools` is belt-and-suspenders against upstream additions to
 *    the default tool set.
 *  - `persistSession: false` — one-shot job, no ~/.claude/projects/
 *    transcript left behind on whatever machine runs this.
 *  - No `env` option is set: per the SDK's own default, omitting it means
 *    the subprocess inherits `process.env` verbatim — exactly the "pass
 *    credentials through untouched" contract (ANTHROPIC_API_KEY or
 *    ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_CUSTOM_HEADERS). */
export function createSdkQuery(): EngineDeps["query"] {
  return async function* query(job: EngineJob): AsyncGenerator<EngineMessage> {
    const sdk = await loadSdk();
    const stream = sdk.query({
      prompt: job.instructions,
      options: {
        cwd: job.root,
        settingSources: [],
        tools: ALLOWED_TOOLS,
        allowedTools: ALLOWED_TOOLS,
        disallowedTools: DISALLOWED_TOOLS,
        permissionMode: "default",
        maxTurns: MAX_TURNS,
        persistSession: false,
      },
    });
    yield* adapt(stream);
  };
}
