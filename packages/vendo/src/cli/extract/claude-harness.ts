import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { confineToolToRoot, resolveThroughSymlinks } from "./confine-to-root.js";
import { extractionModelPin, type ExtractionHarness, type ExtractionRunInput } from "./harness.js";

/**
 * V1 extraction harness: the Claude Agent SDK driven headless with READ-ONLY
 * code tools (Read/Glob/Grep) over the host root. Credential = the dev's
 * Claude Code login, or their ANTHROPIC_API_KEY. The SDK resolves from the
 * CLI's own installation first, then the host app — it is never installed
 * into the host app by init.
 *
 * Isolation: `settingSources: []` (never inherit the dev's personal Claude
 * Code settings/hooks), read-only tool set, no shell/web/write surface, and
 * `canUseTool` confining every read to the host root (confine-to-root.ts).
 * `tools` rather than `allowedTools` on purpose: a blanket allowlist
 * auto-allows Read/Glob/Grep on ANY path and never consults the callback.
 */

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const PROBE_TIMEOUT_MS = 5_000;

interface SdkModule {
  query(params: { prompt: string; options: Record<string, unknown> }): AsyncIterable<Record<string, unknown>>;
}

/** Bundler-proof dynamic import (same pattern as dev-creds): the
 *  Function body is a FIXED literal — the specifier is a parameter, never
 *  interpolated into code — so there is no injection surface. */
async function dynamicImport(url: string): Promise<Record<string, unknown>> {
  try {
    return await import(url) as Record<string, unknown>;
  } catch (nativeError) {
    try {
      const escaped = new Function("specifier", "return import(specifier)") as (
        specifier: string,
      ) => Promise<Record<string, unknown>>;
      return await escaped(url);
    } catch {
      throw nativeError;
    }
  }
}

/** Resolve the SDK from the CLI package itself, then from the host app. */
async function loadSdk(root: string): Promise<SdkModule | null> {
  for (const base of [import.meta.url, pathToFileURL(join(root, "package.json")).href]) {
    try {
      const require = createRequire(base);
      return await dynamicImport(pathToFileURL(require.resolve(SDK_PACKAGE)).href) as unknown as SdkModule;
    } catch {
      // try the next resolution base
    }
  }
  return null;
}

/** Is the SDK RESOLVABLE from the CLI or the host app, without importing it?
 *  `availability()` answers "is it here" with this — resolving a specifier runs
 *  no module code, where `loadSdk`'s import would execute host-resolved code
 *  just to probe. The resolution bases mirror loadSdk's exactly. */
function sdkResolves(root: string): boolean {
  for (const base of [import.meta.url, pathToFileURL(join(root, "package.json")).href]) {
    try {
      createRequire(base).resolve(SDK_PACKAGE);
      return true;
    } catch {
      // try the next resolution base
    }
  }
  return false;
}

/** `claude auth status` prints JSON with a `loggedIn` boolean. */
function probeClaudeLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("claude", ["auth", "status"], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error !== null) return resolve(false);
      try {
        resolve((JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true);
      } catch {
        resolve(false);
      }
    });
  });
}

export interface ClaudeHarnessOptions {
  /** Test seams. */
  loadSdk?: (root: string) => Promise<SdkModule | null>;
  probeLogin?: () => Promise<boolean>;
}

export function claudeHarness(options: ClaudeHarnessOptions = {}): ExtractionHarness {
  const load = options.loadSdk ?? loadSdk;
  const probe = options.probeLogin ?? probeClaudeLogin;
  // Presence for availability, WITHOUT executing host-resolved module code: in
  // production resolve the specifier and never import it; a test's fake loadSdk
  // imports nothing, so honoring it when supplied keeps that seam intact.
  const present = async (root: string): Promise<boolean> =>
    options.loadSdk === undefined ? sdkResolves(root) : (await options.loadSdk(root)) !== null;
  return {
    id: "claude-agent-sdk",
    async availability({ root, env }) {
      // Credential first, so a repo with no credential never reaches the SDK
      // probe — and the probe is a resolve, never an import.
      const key = env["ANTHROPIC_API_KEY"];
      const label = typeof key === "string" && key.trim().length > 0
        ? "your ANTHROPIC_API_KEY"
        : (await probe()) ? "your Claude Code login" : null;
      if (label === null) return null;
      return (await present(root)) ? label : null;
    },
    async run(input: ExtractionRunInput): Promise<string> {
      const sdk = await load(input.root);
      if (sdk === null) throw new Error(`${SDK_PACKAGE} is not available`);
      const model = extractionModelPin(input.env);
      // Containment is judged against the REALPATH of the root: if the host
      // root is itself reached through a symlink (macOS /tmp -> /private/tmp),
      // tool paths resolve to the real side and a string-prefix check against
      // the raw root would misjudge every one of them.
      const rootRealpath = resolveThroughSymlinks(input.root);
      const stream = sdk.query({
        prompt: input.instructions,
        options: {
          cwd: input.root,
          settingSources: [],
          tools: ["Read", "Glob", "Grep"],
          disallowedTools: [
            "Bash", "Write", "Edit", "WebFetch", "WebSearch", "Task",
            "TodoWrite", "NotebookEdit", "KillShell", "BashOutput",
          ],
          permissionMode: "default",
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>) =>
            confineToolToRoot(toolName, toolInput, rootRealpath),
          maxTurns: 40,
          // Forward the caller's env so a key present only in the passed map
          // (not process.env) still authenticates the SDK subprocess.
          env: { ...process.env, ...input.env },
          ...(model === undefined ? {} : { model }),
        },
      });
      let finalText = "";
      const assistantText: string[] = [];
      for await (const message of stream) {
        const type = message["type"];
        if (type === "assistant") {
          const content = (message["message"] as { content?: Array<Record<string, unknown>> } | undefined)?.content;
          for (const part of content ?? []) {
            if (part["type"] === "text" && typeof part["text"] === "string") {
              assistantText.push(part["text"]);
            } else if (part["type"] === "tool_use") {
              const name = part["name"];
              const file = (part["input"] as { file_path?: unknown; pattern?: unknown } | undefined);
              const target = typeof file?.file_path === "string" ? file.file_path
                : typeof file?.pattern === "string" ? file.pattern : "";
              if (typeof name === "string") input.onProgress?.(`${name.toLowerCase()} ${target}`.trim());
            }
          }
        } else if (type === "result" && typeof message["result"] === "string") {
          finalText = message["result"];
        }
      }
      return finalText.length > 0 ? finalText : assistantText.join("\n");
    },
  };
}
