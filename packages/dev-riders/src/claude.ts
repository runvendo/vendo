import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RiderSession, RiderSessionStart } from "./types.js";

/**
 * Claude-session rider (install-dx design §2 rung 2, spike ENG-337): one
 * persistent Claude Agent SDK session per Vendo thread, riding the machine's
 * authed `claude` CLI login. Vendo host tools are bridged via an in-process
 * MCP server; consent stays with the runtime (the tool handler awaits the
 * guard-parked executor, which the spike proved parks unboundedly).
 *
 * The SDK is resolved from the HOST app's node_modules at runtime — this
 * package never depends on it, keeping its zod@4 peer out of every other
 * consumer's dependency graph. `vendo init` offers the install with consent.
 *
 * Isolation invariants (spike gotchas, all load-bearing):
 * - `settingSources: []` — NEVER inherit the developer's personal Claude Code
 *   settings, hooks, or project config into the ridden session.
 * - `tools: []` + `disallowedTools` + a deny-all-non-vendo `canUseTool` —
 *   the ridden harness gets no filesystem/shell/web surface, only vendo tools.
 * - ANTHROPIC_API_KEY is stripped from the subprocess env so the session rides
 *   the login (this rung only runs when the ladder found no env key anyway).
 * - Streaming-input mode emits NOTHING (not even system:init) until the first
 *   user message — never wait for init after start.
 */

export const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** Built-in harness tools locked out as defense in depth beside `tools: []`. */
const DISALLOWED_BUILT_INS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch",
  "Task", "TodoWrite", "NotebookEdit", "KillShell", "BashOutput", "ExitPlanMode",
];

interface SdkQuery extends AsyncIterable<Record<string, unknown>> {
  interrupt?(): Promise<unknown>;
}

interface AgentSdkModule {
  query(params: { prompt: AsyncIterable<unknown> | string; options: Record<string, unknown> }): SdkQuery;
}

export interface ClaudeRiderOptions {
  /** Host app root the SDK (and its MCP peer) resolve from; defaults to cwd. */
  root?: string;
  /** Optional model override (e.g. VENDO_DEV_CLAUDE_MODEL); defaults to the login's default. */
  model?: string;
  /** Test seam: inject the SDK module instead of resolving it from the host. */
  loadSdk?: () => Promise<AgentSdkModule>;
  /** Test seam: inject the MCP server factory. */
  createMcpInstance?: (start: RiderSessionStart) => Promise<unknown>;
}

function hostRequire(root: string): NodeRequire {
  return createRequire(join(root, "package.json"));
}

/** Bundler-proof dynamic import. This module runs inside the HOST's dev
 *  server (Next/webpack/turbopack bundle it), where a computed `import(...)`
 *  is replaced with a runtime stub that throws "expression is too dynamic".
 *  Try the native import first (works in plain Node and test VMs), then fall
 *  back to a Function-constructed import the bundler cannot see. The Function
 *  body is a FIXED literal; the specifier is a parameter, never interpolated. */
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

async function importFrom(root: string, specifier: string): Promise<Record<string, unknown>> {
  return await dynamicImport(pathToFileURL(hostRequire(root).resolve(specifier)).href);
}

/** Resolve the Agent SDK from the host app; a missing install gets the exact
 *  fix-it command instead of a bare module-not-found. */
async function loadAgentSdk(root: string): Promise<{ sdk: AgentSdkModule; sdkPath: string }> {
  let sdkPath: string;
  try {
    sdkPath = hostRequire(root).resolve(CLAUDE_AGENT_SDK_PACKAGE);
  } catch {
    throw new Error(
      `The Claude-session dev rung needs ${CLAUDE_AGENT_SDK_PACKAGE} in this app. `
        + `Install it (\`npm install -D ${CLAUDE_AGENT_SDK_PACKAGE}\`) or set a model key. `
        + "`vendo init` offers this install during setup.",
    );
  }
  const sdk = await dynamicImport(pathToFileURL(sdkPath).href) as unknown as AgentSdkModule;
  return { sdk, sdkPath };
}

/** The in-process MCP server carrying Vendo's host tools. Built on the LOW-LEVEL
 *  request handlers (not the SDK's zod `tool()` helper) so extracted tools'
 *  raw JSON Schemas pass through verbatim — no zod import, no schema loss. The
 *  MCP SDK is the agent SDK's own peer; resolve it beside the SDK first, then
 *  from the host root. */
async function createVendoMcpInstance(root: string, sdkPath: string, start: RiderSessionStart): Promise<unknown> {
  const roots = [dirname(sdkPath), root];
  let mcpModule: Record<string, unknown> | undefined;
  let typesModule: Record<string, unknown> | undefined;
  for (const candidate of roots) {
    try {
      mcpModule = await importFrom(candidate, "@modelcontextprotocol/sdk/server/mcp.js");
      typesModule = await importFrom(candidate, "@modelcontextprotocol/sdk/types.js");
      break;
    } catch {
      // try the next resolution root
    }
  }
  if (mcpModule === undefined || typesModule === undefined) {
    throw new Error(
      "Could not resolve @modelcontextprotocol/sdk (the Claude Agent SDK's peer) from this app; "
        + `reinstall with \`npm install -D ${CLAUDE_AGENT_SDK_PACKAGE}\`.`,
    );
  }
  const McpServer = mcpModule["McpServer"] as new (
    info: { name: string; version: string },
    options: { capabilities: Record<string, unknown> },
  ) => { server: { setRequestHandler(schema: unknown, handler: (request: never) => Promise<unknown>): void } };
  const instance = new McpServer({ name: "vendo", version: "0.0.0" }, { capabilities: { tools: {} } });
  instance.server.setRequestHandler(typesModule["ListToolsRequestSchema"], async () => ({
    tools: start.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));
  instance.server.setRequestHandler(typesModule["CallToolRequestSchema"], async (request) => {
    const params = (request as { params: { name: string; arguments?: unknown } }).params;
    const result = await start.onToolCall({ tool: params.name, args: params.arguments ?? {} });
    return { content: [{ type: "text", text: result.text }], isError: !result.ok };
  });
  return instance;
}

interface PendingTurn {
  text: string;
  onTextDelta(delta: string): void;
  resolve(result: { text: string }): void;
  reject(error: Error): void;
}

export class ClaudeSessionRider implements RiderSession {
  private readonly options: ClaudeRiderOptions;
  private q: SdkQuery | null = null;
  private queue: unknown[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private pending: PendingTurn | null = null;
  /** The login's reported model (system:init), for diagnostics. */
  model: string | undefined;

  constructor(options: ClaudeRiderOptions = {}) {
    this.options = options;
  }

  private async *input(): AsyncGenerator<unknown> {
    while (!this.closed) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }

  async start(start: RiderSessionStart): Promise<void> {
    const root = this.options.root ?? process.cwd();
    let sdk: AgentSdkModule;
    let mcpInstance: unknown = null;
    if (this.options.loadSdk !== undefined) {
      sdk = await this.options.loadSdk();
      if (start.tools.length > 0 && this.options.createMcpInstance !== undefined) {
        mcpInstance = await this.options.createMcpInstance(start);
      }
    } else {
      const loaded = await loadAgentSdk(root);
      sdk = loaded.sdk;
      if (start.tools.length > 0) {
        mcpInstance = await createVendoMcpInstance(root, loaded.sdkPath, start);
      }
    }

    const env: Record<string, string | undefined> = { ...process.env };
    delete env["ANTHROPIC_API_KEY"];

    this.q = sdk.query({
      prompt: this.input(),
      options: {
        ...(mcpInstance === null
          ? {}
          : { mcpServers: { vendo: { type: "sdk", name: "vendo", instance: mcpInstance } } }),
        tools: [],
        disallowedTools: DISALLOWED_BUILT_INS,
        systemPrompt: start.system,
        settingSources: [],
        includePartialMessages: true,
        maxTurns: 100,
        cwd: root,
        env,
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        canUseTool: async (toolName: string, input: unknown) =>
          toolName.startsWith("mcp__vendo__")
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "Only vendo tools are permitted." },
        stderr: () => {},
      },
    });
    // Streaming-input mode emits nothing until the first user message is
    // yielded — consume in the background, never block on init here.
    void this.consume();
  }

  private async consume(): Promise<void> {
    if (this.q === null) return;
    try {
      for await (const message of this.q) {
        const type = message["type"];
        if (type === "system" && message["subtype"] === "init") {
          this.model = message["model"] as string | undefined;
        } else if (type === "stream_event") {
          const event = message["event"] as { type?: string; delta?: { type?: string; text?: string } } | undefined;
          if (
            this.pending !== null
            && event?.type === "content_block_delta"
            && event.delta?.type === "text_delta"
            && typeof event.delta.text === "string"
          ) {
            this.pending.onTextDelta(event.delta.text);
            this.pending.text += event.delta.text;
          }
        } else if (type === "result") {
          const pending = this.pending;
          this.pending = null;
          const resultText = message["result"];
          pending?.resolve({ text: typeof resultText === "string" && resultText.length > 0 ? resultText : pending.text });
        }
      }
      // The session ended (interrupt/exit); fail any turn still in flight.
      this.pending?.reject(new Error("claude session ended"));
      this.pending = null;
    } catch (error) {
      const pending = this.pending;
      this.pending = null;
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  runTurn(text: string, onTextDelta: (delta: string) => void): Promise<{ text: string }> {
    if (this.q === null) return Promise.reject(new Error("claude session not started"));
    if (this.pending !== null) return Promise.reject(new Error("claude session already has a turn in flight"));
    return new Promise((resolve, reject) => {
      this.pending = { text: "", onTextDelta, resolve, reject };
      this.queue.push({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
      });
      this.wake?.();
    });
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.wake?.();
    try {
      await this.q?.interrupt?.();
    } catch {
      // already gone
    }
    this.q = null;
  }
}
