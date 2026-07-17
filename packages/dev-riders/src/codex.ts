import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RiderSession, RiderSessionStart } from "./types.js";

/**
 * Codex-session rider (install-dx design §2 rung 3, spike ENG-337): one
 * `codex app-server` thread per Vendo thread, riding the machine's ChatGPT
 * login (~/.codex/auth.json). Vendo host tools are first-class dynamicTools —
 * codex executes them by sending the client an `item/tool/call` JSON-RPC
 * request; delaying that response IS the approval park (protocol-unbounded).
 *
 * Protocol notes (verified against codex-cli 0.144.x via
 * `codex app-server generate-ts`): newline-delimited JSON-RPC 2.0 over stdio;
 * `initialize` (with `capabilities.experimentalApi: true` — dynamicTools is
 * gated on it) → `initialized` notification → `thread/start` → `turn/start`
 * per user turn; `item/agentMessage/delta` streams text; `turn/completed`
 * ends a turn. The surface is upstream-experimental: any spawn/handshake
 * failure degrades with a clear message instead of crashing the dev server.
 *
 * Isolation (all load-bearing):
 * - The subprocess runs with a PRIVATE CODEX_HOME carrying only a copy of the
 *   login credentials (auth.json) — never the developer's personal config:
 *   a shared home would load their MCP servers (mail, issue trackers, browser
 *   automation, …) straight into the ridden session as executable tools.
 * - `sandbox: "read-only"` + `approvalPolicy: "untrusted"` and every harness
 *   command/patch approval request is denied — no shell/filesystem surface,
 *   only vendo tools.
 */

type Json = Record<string, unknown>;

/**
 * The codex-cli minor line this rider's app-server protocol shapes were
 * verified against (spike ENG-337 REPORT.md). The `dynamicTools` surface is
 * upstream-experimental AND feature-gated, and this rider reads tool calls by
 * field name (`params.tool` / `params.arguments`); a codex upgrade that renames
 * those fields degrades tool calls to "Unknown tool" silently. Doctor v2 warns
 * (dev-only, informational) when the installed codex drifts off this line.
 */
export const TESTED_CODEX_MINOR = "0.144";

/** Best-effort `codex --version` probe. Returns the parsed x.y.z string, or
 *  null when codex is absent or unparseable. Never throws. */
export function probeCodexVersion(command = "codex"): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 5_000 }, (error, stdout) => {
      if (error !== null) return resolve(null);
      const match = /(\d+\.\d+\.\d+)/.exec(stdout ?? "");
      resolve(match ? match[1]! : null);
    });
  });
}

/** Whether an x.y.z version sits on the tested minor line (x.y match). */
export function codexVersionMatchesTested(version: string): boolean {
  const parts = version.split(".");
  return parts.length >= 2 && `${parts[0]}.${parts[1]}` === TESTED_CODEX_MINOR;
}

export interface CodexRiderOptions {
  /** Binary to spawn; defaults to `codex` on PATH. Test seam: point at a stub. */
  command?: string;
  args?: string[];
  cwd?: string;
  /** Optional per-thread model override (e.g. VENDO_DEV_CODEX_MODEL). */
  model?: string;
  /** The developer's real codex home the login is copied FROM (default ~/.codex). */
  sourceHome?: string;
  /** Skip the private-CODEX_HOME isolation (tests with a stub binary only). */
  isolateHome?: boolean;
}

interface PendingTurn {
  text: string;
  onTextDelta(delta: string): void;
  resolve(result: { text: string }): void;
  reject(error: Error): void;
}

const HARNESS_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);

export class CodexSessionRider implements RiderSession {
  private readonly options: CodexRiderOptions;
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private nextId = 1;
  private readonly inflight = new Map<number, { resolve(value: Json): void; reject(error: Error): void }>();
  private threadId: string | null = null;
  private pending: PendingTurn | null = null;
  private onToolCall: RiderSessionStart["onToolCall"] | null = null;
  private privateHome: string | null = null;
  /** The thread's reported model, for diagnostics. */
  model: string | undefined;

  constructor(options: CodexRiderOptions = {}) {
    this.options = options;
  }

  private send(payload: Json): void {
    this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private request(method: string, params: Json): Promise<Json> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.inflight.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async start(start: RiderSessionStart): Promise<void> {
    this.onToolCall = start.onToolCall;
    const command = this.options.command ?? "codex";
    const args = this.options.args ?? ["app-server"];
    const cwd = this.options.cwd ?? process.cwd();
    const env: Record<string, string | undefined> = { ...process.env };
    if (this.options.isolateHome !== false) {
      // Private CODEX_HOME: the login rides along, the personal config does not.
      this.privateHome = await mkdtemp(join(tmpdir(), "vendo-codex-home-"));
      const sourceHome = this.options.sourceHome ?? join(homedir(), ".codex");
      await copyFile(join(sourceHome, "auth.json"), join(this.privateHome, "auth.json")).catch(() => undefined);
      // Minimal config: no harness side tools beyond the vendo dynamicTools.
      await writeFile(
        join(this.privateHome, "config.toml"),
        "# Vendo dev-mode rider — generated; the developer's personal config never rides along.\n[tools]\nweb_search = false\nview_image = false\n",
        "utf8",
      ).catch(() => undefined);
      env["CODEX_HOME"] = this.privateHome;
    }
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env });
    this.child = child as ChildProcessByStdio<Writable, Readable, Readable>;

    const spawnFailure = new Promise<never>((_, reject) => {
      child.once("error", (error: NodeJS.ErrnoException) => {
        reject(new Error(
          error.code === "ENOENT"
            ? `The Codex-session dev rung needs the \`${command}\` CLI on PATH (and a completed \`codex login\`).`
            : `codex app-server failed to start: ${error.message}`,
        ));
      });
      child.once("exit", (code) => {
        reject(new Error(`codex app-server exited during startup (code ${code ?? "unknown"}); the app-server surface is experimental — check \`codex --version\` compatibility.`));
      });
    });
    spawnFailure.catch(() => undefined);

    const readline = createInterface({ input: this.child.stdout });
    readline.on("line", (line) => {
      if (!line.trim()) return;
      let message: Json;
      try {
        message = JSON.parse(line) as Json;
      } catch {
        return;
      }
      void this.onMessage(message);
    });

    const handshake = (async () => {
      await this.request("initialize", {
        clientInfo: { name: "vendo-dev-rider", title: "Vendo dev mode", version: "0.3.0" },
        capabilities: { experimentalApi: true },
      });
      this.send({ jsonrpc: "2.0", method: "initialized" });
      const started = await this.request("thread/start", {
        cwd,
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "untrusted",
        // The environment note counters the harness's own capability talk:
        // shell/file/web surfaces are denied here, only vendo tools execute.
        developerInstructions: `${start.system}\n\nEnvironment note: you are embedded in this product as its assistant — present yourself that way. Only the provided vendo tools are available; shell, file, web, and image tools do not work in this environment and must not be offered.`,
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        ...(start.tools.length === 0 ? {} : {
          dynamicTools: start.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }),
      });
      this.model = (started as { model?: string }).model;
      this.threadId = (started as { thread?: { id?: string } }).thread?.id ?? null;
      if (this.threadId === null) {
        throw new Error(`codex thread/start returned no thread id (protocol drift?): ${JSON.stringify(started)}`);
      }
    })();

    await Promise.race([handshake, spawnFailure]);
    // Startup succeeded: from here a process exit fails in-flight turns instead.
    child.removeAllListeners("exit");
    child.once("exit", () => {
      const pending = this.pending;
      this.pending = null;
      pending?.reject(new Error("codex app-server exited"));
      for (const slot of this.inflight.values()) slot.reject(new Error("codex app-server exited"));
      this.inflight.clear();
    });
  }

  private async onMessage(message: Json): Promise<void> {
    // A response to one of our requests.
    if (typeof message["id"] === "number" && !("method" in message)) {
      const slot = this.inflight.get(message["id"]);
      if (slot === undefined) return;
      this.inflight.delete(message["id"]);
      if (message["error"] !== undefined) slot.reject(new Error(JSON.stringify(message["error"])));
      else slot.resolve((message["result"] ?? {}) as Json);
      return;
    }

    const method = message["method"] as string | undefined;
    const params = (message["params"] ?? {}) as Json;

    // Server → client REQUEST: a dynamic (vendo) tool call. The delayed
    // response is the approval park.
    if (method === "item/tool/call" && message["id"] !== undefined) {
      const tool = params["tool"] as string;
      const result = this.onToolCall === null
        ? { text: "Tool bridge not ready.", ok: false }
        : await this.onToolCall({ tool, args: params["arguments"] ?? {} });
      this.send({
        jsonrpc: "2.0",
        id: message["id"] as number,
        result: { contentItems: [{ type: "inputText", text: result.text }], success: result.ok },
      });
      return;
    }

    // Harness command/patch approvals: always denied — the ridden agent has no
    // business touching the developer's shell or files.
    if (message["id"] !== undefined && method !== undefined && HARNESS_APPROVAL_METHODS.has(method)) {
      this.send({ jsonrpc: "2.0", id: message["id"] as number, result: { decision: "denied" } });
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = String(params["delta"] ?? "");
      if (this.pending !== null && delta.length > 0) {
        this.pending.onTextDelta(delta);
        this.pending.text += delta;
      }
      return;
    }
    if (method === "turn/completed") {
      const pending = this.pending;
      this.pending = null;
      const turn = params["turn"] as { status?: string } | undefined;
      if (turn?.status === "failed" || turn?.status === "error") {
        pending?.reject(new Error(`codex turn ${turn.status}`));
      } else {
        pending?.resolve({ text: pending.text });
      }
    }
  }

  runTurn(text: string, onTextDelta: (delta: string) => void): Promise<{ text: string }> {
    if (this.threadId === null) return Promise.reject(new Error("codex session not started"));
    if (this.pending !== null) return Promise.reject(new Error("codex session already has a turn in flight"));
    return new Promise((resolve, reject) => {
      this.pending = { text: "", onTextDelta, resolve, reject };
      this.request("turn/start", {
        threadId: this.threadId!,
        input: [{ type: "text", text, text_elements: [] }],
      }).catch((error: Error) => {
        if (this.pending === null) return;
        this.pending = null;
        reject(error);
      });
    });
  }

  async dispose(): Promise<void> {
    this.child?.kill("SIGTERM");
    this.child = null;
    this.threadId = null;
    if (this.privateHome !== null) {
      // Best-effort: the copied credentials must not outlive the session.
      await rm(this.privateHome, { recursive: true, force: true }).catch(() => undefined);
      this.privateHome = null;
    }
  }
}
