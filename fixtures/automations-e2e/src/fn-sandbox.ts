/** A fixture-local, in-process SandboxAdapter for the fn:-step e2e legs.
 *
 * The brief calls for "createApps with a FakeSandbox" to exercise the 07 §4
 * fn: path through a REAL apps runtime while the user is away. The real
 * FakeSandbox lives at packages/apps/src/testing, but @vendoai/apps exports
 * only ".", "./e2b" and "./modal" — the testing subpath is not importable, and
 * this lane may not touch packages/apps to add one. So we implement the frozen
 * SandboxAdapter / SandboxMachine seam here: everything downstream of it — the
 * apps runtime's machine session, run-token minting, /fn/<name> dispatch, and
 * the { result } / { error } envelope parsing in call.ts — is the real code
 * under test. Only the transport is in-process.
 *
 * The handler answers a POST /fn/<name> the way a machine would: a 2xx with a
 * body is a success envelope (`{ result }` or `{ ui }`); a non-2xx with
 * `{ error: { code, message } }` is the machine's failure envelope.
 */
// execution-v2 transition: this fixture still speaks the archived v1 machine
// surface the automations fn: path consumes (compat until Wave 2 Lane D).
import type { V1SandboxAdapter, V1SandboxMachine } from "@vendoai/apps";
import type { Json } from "@vendoai/core";

export interface FnResponse {
  status: number;
  body: Json;
}

export type FnHandler = (name: string, args: Json) => FnResponse | Promise<FnResponse>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const parseArgs = (body: Uint8Array | string | undefined): Json => {
  if (body === undefined) return {};
  const text = typeof body === "string" ? body : decoder.decode(body);
  try {
    const parsed = JSON.parse(text) as { args?: Json };
    return parsed.args ?? {};
  } catch {
    return {};
  }
};

/** Build a SandboxAdapter whose machine dispatches POST /fn/<name> to `handler`. */
export function fnSandbox(handler: FnHandler): V1SandboxAdapter {
  let counter = 0;
  const makeMachine = (): V1SandboxMachine => {
    const id = `fake_${counter++}`;
    let stopped = false;
    return {
      id,
      async request(req) {
        if (stopped) throw new Error(`machine ${id} is stopped`);
        const match = /^\/fn\/(.+)$/.exec(req.path);
        const name = match?.[1] ?? "";
        const { status, body } = await handler(name, parseArgs(req.body));
        return {
          status,
          headers: { "content-type": "application/json" },
          body: encoder.encode(JSON.stringify(body)),
        };
      },
      async exec() {
        return { code: 0, stdout: "", stderr: "" };
      },
      files: {
        async read() {
          throw new Error("fnSandbox has no file surface");
        },
        async write() {
          /* no-op */
        },
        async list() {
          return [];
        },
      },
      async snapshot() {
        return "fake:snap";
      },
      async stop() {
        stopped = true;
      },
    };
  };
  return {
    async create() {
      return makeMachine();
    },
    async resume() {
      return makeMachine();
    },
  };
}
