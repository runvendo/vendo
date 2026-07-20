import type { SandboxAdapter, SandboxMachine } from "../sandbox.js";
import type { BoxEditResult } from "../box-agent.js";
import { BOX_CONTROL_PORT } from "../box-agent.js";

/**
 * execution-v2 Wave 3 test substrate — a fake sandbox that models a REAL v2
 * box faithfully: two listeners (the app's $PORT and the harness control port
 * 8811), an injectable in-box agent, a `vendo.json` manifest, POST /fn/<name>
 * handlers the agent installs, env re-injection, and snapshot/resume
 * persistence. It exists so graduation, editApp, schedule ticks, and the
 * prompt-injection floor can be exercised without live e2b — the shared
 * single-listener fakeSandbox stays untouched.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The mutable inside-the-box state an in-box agent edits. */
export interface FakeBoxState {
  env: Record<string, string>;
  /** The vendo.json the box serves (schedules + egress declarations). */
  manifest: { schedules?: Array<{ cron: string; fn: string }>; egress?: string[] };
  /** POST /fn/<name> handlers the agent installed. */
  fns: Map<string, (args: unknown, env: Record<string, string>) => unknown>;
  /**
   * Wave 4 (layer 3) — served pages the agent installed on non-/fn GET paths
   * (path → HTML body). When present, the box "serves a real web app".
   */
  pages: Map<string, string>;
}

/** The injectable in-box coding agent: mutates box state, returns a result. */
export type FakeBoxAgent = (task: {
  prompt: string;
  context?: string;
  env: Record<string, string>;
  box: FakeBoxState;
}) => BoxEditResult | Promise<BoxEditResult>;

interface BoxSnapshot {
  env: Record<string, string>;
  manifest: FakeBoxState["manifest"];
  fns: Map<string, (args: unknown, env: Record<string, string>) => unknown>;
  pages: Map<string, string>;
  allowedDomains?: readonly string[];
}

interface FakeBoxOptions {
  agent?: FakeBoxAgent;
}

const snapshots = new Map<string, BoxSnapshot>();
let nextId = 1;
let nextSnap = 1;

export interface FakeBoxAdapter extends SandboxAdapter {
  /** Every machine this adapter created (for assertions on live/torn-down state). */
  readonly machines: FakeBoxMachine[];
}

class FakeBoxMachine implements SandboxMachine {
  readonly id = `box-${nextId++}`;
  destroyed = false;
  stopped = false;
  /** Task results by id (control-port task store). */
  private readonly tasks = new Map<string, { status: "running" | "done"; result?: BoxEditResult }>();

  constructor(
    readonly state: FakeBoxState,
    readonly allowedDomains: readonly string[] | undefined,
    private readonly agent: FakeBoxAgent,
  ) {}

  private appPort(): number {
    const port = Number(this.state.env.PORT ?? 8080);
    return Number.isInteger(port) && port > 0 ? port : 8080;
  }

  async request(req: {
    method: string;
    path: string;
    port?: number;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
    if (this.destroyed || this.stopped) throw new Error(`box ${this.id} is not running`);
    const bodyText = req.body === undefined ? "" : typeof req.body === "string" ? req.body : decoder.decode(req.body);
    const port = req.port ?? this.appPort();
    const json = (status: number, value: unknown) => ({
      status,
      headers: { "content-type": "application/json" },
      body: encoder.encode(JSON.stringify(value)),
    });
    if (port === BOX_CONTROL_PORT) return this.control(req.method, req.path, bodyText, json);
    if (port === this.appPort()) return this.app(req.method, req.path, bodyText, json);
    throw new Error(`box ${this.id} has no listener on port ${port}`);
  }

  private async control(
    method: string,
    path: string,
    bodyText: string,
    json: (status: number, value: unknown) => { status: number; headers: Record<string, string>; body: Uint8Array },
  ) {
    const route = `${method} ${path}`;
    if (route === "GET /agent/health") return json(200, { ok: true, harness: "fake-box/1", app: { running: true } });
    if (route === "POST /agent/env") {
      const env = (JSON.parse(bodyText) as { env: Record<string, string> }).env;
      this.state.env = { ...this.state.env, ...env };
      return json(200, { ok: true });
    }
    if (route === "POST /agent/restart-app") return json(200, { ok: true });
    if (route === "POST /agent/task") {
      const payload = JSON.parse(bodyText) as { prompt: string; context?: string };
      const taskId = `boxtask_${this.id}_${this.tasks.size}`;
      this.tasks.set(taskId, { status: "running" });
      const result = await this.agent({ prompt: payload.prompt, context: payload.context, env: this.state.env, box: this.state });
      this.tasks.set(taskId, { status: "done", result });
      return json(202, { taskId });
    }
    if (method === "GET" && path.startsWith("/agent/task/")) {
      const entry = this.tasks.get(path.slice("/agent/task/".length));
      if (entry === undefined) return json(404, { error: "unknown task" });
      return json(200, { status: entry.status, ...(entry.result === undefined ? {} : { result: entry.result }), log: "" });
    }
    return json(404, { error: `unknown control route: ${route}` });
  }

  private app(
    method: string,
    path: string,
    bodyText: string,
    json: (status: number, value: unknown) => { status: number; headers: Record<string, string>; body: Uint8Array },
  ) {
    if (method === "GET" && path === "/vendo.json") {
      if (this.state.manifest.schedules === undefined && this.state.manifest.egress === undefined) {
        return json(404, { error: "no manifest" });
      }
      return json(200, this.state.manifest);
    }
    // Wave 4 (layer 3) — agent-installed served pages win over the default
    // ok-stub, so tests can prove a real web app is served beside /fn.
    const page = this.state.pages.get(path);
    if (method === "GET" && page !== undefined) {
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: encoder.encode(page),
      };
    }
    const fnMatch = /^\/fn\/([A-Za-z_][A-Za-z0-9_-]*)$/.exec(path);
    if (method === "POST" && fnMatch?.[1] !== undefined) {
      const handler = this.state.fns.get(fnMatch[1]);
      if (handler === undefined) return json(404, { error: { code: "not-found", message: `no fn ${fnMatch[1]}` } });
      const args = (() => { try { return (JSON.parse(bodyText) as { args?: unknown }).args; } catch { return undefined; } })();
      try {
        const result = handler(args, this.state.env);
        return json(200, { result });
      } catch (error) {
        return json(500, { error: { code: "machine", message: error instanceof Error ? error.message : "fn failed" } });
      }
    }
    return json(200, { ok: true });
  }

  async url(port?: number): Promise<string> {
    return `https://${port ?? this.appPort()}-${this.id}.fake-box.test`;
  }

  async snapshot(): Promise<string> {
    if (this.destroyed || this.stopped) throw new Error(`box ${this.id} is not running`);
    const ref = `fakebox:snap_${nextSnap++}`;
    snapshots.set(ref, {
      env: { ...this.state.env },
      manifest: structuredClone(this.state.manifest),
      fns: new Map(this.state.fns),
      pages: new Map(this.state.pages),
      ...(this.allowedDomains === undefined ? {} : { allowedDomains: [...this.allowedDomains] }),
    });
    return ref;
  }

  async stop(): Promise<void> { this.stopped = true; }
  async destroy(): Promise<void> { this.destroyed = true; this.stopped = true; }
}

export const fakeBoxSandbox = (options: FakeBoxOptions = {}): FakeBoxAdapter => {
  const machines: FakeBoxMachine[] = [];
  // Default agent: a no-op that reports success but changes nothing.
  const agent: FakeBoxAgent = options.agent ?? (() => ({ ok: true, summary: "noop", filesChanged: [], testsRun: 0 }));

  const make = (state: FakeBoxState, allowedDomains: readonly string[] | undefined): FakeBoxMachine => {
    const machine = new FakeBoxMachine(state, allowedDomains, agent);
    machines.push(machine);
    return machine;
  };

  return {
    machines,
    async create(spec) {
      return make(
        { env: { ...spec.env }, manifest: {}, fns: new Map(), pages: new Map() },
        spec.allowedDomains,
      );
    },
    async resume(snapshotRef, policy) {
      const snap = snapshots.get(snapshotRef);
      if (snap === undefined) throw new Error(`unknown fake-box snapshot: ${snapshotRef}`);
      return make(
        { env: { ...snap.env }, manifest: structuredClone(snap.manifest), fns: new Map(snap.fns), pages: new Map(snap.pages) },
        policy === undefined ? snap.allowedDomains : policy.allowedDomains,
      );
    },
    async destroy(snapshotRef) {
      if (!snapshotRef.startsWith("fakebox:")) throw new Error(`not a fake-box ref: ${snapshotRef}`);
      snapshots.delete(snapshotRef);
    },
  };
};
