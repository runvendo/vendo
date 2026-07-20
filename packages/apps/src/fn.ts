import {
  VendoError,
  type AppDocument,
  type Json,
  type RunContext,
  type ToolOutcome,
} from "@vendoai/core";
import { FN_NAME_PATTERN, fnOutcome, type AppCaller } from "./call.js";
import { requestAppWithBootRetry, type BootRetryOptions } from "./box-agent.js";
import type { SandboxMachine } from "./sandbox.js";

/**
 * execution-v2 Wave 2 Lane D — fn: resolution over the box door. A v2 tree
 * whose query or action names `fn:<name>` resolves here: wake the app's
 * machine (Lane B's lifecycle) and POST the skin-contract `/fn/<name>` route
 * (Lane C's proxy speaks the same door from the wire). The host ToolRegistry
 * never sees an fn: ref; the box never sees host credentials — only
 * content-type crosses the skin, exactly like the wire proxy.
 *
 * Containment rule: a failed fn is a contained error OUTCOME (the query slot
 * stays unbound, the action renders its error state) — never a thrown white
 * box. Responses bind exactly like tool results: `{result}` becomes
 * `{status:"ok", output}`, `{error:{code,message}}` relays as-is.
 */

const decoder = new TextDecoder();

const errorOutcome = (code: string, message: string): ToolOutcome => ({
  status: "error",
  error: { code, message },
});

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

export interface FnCallerConfig {
  /** Lane B's machine lifecycle wake — the only runtime door into the box. */
  wake(app: AppDocument): Promise<SandboxMachine>;
  /** Test seam: shrink the post-resume boot-retry so fn tests run instantly. */
  bootRetry?: BootRetryOptions;
}

export interface FnCaller {
  /** Execute one box function as a tool outcome (see containment rule above). */
  callFn(app: AppDocument, name: string, args: Json, ctx: RunContext): Promise<ToolOutcome>;
  /**
   * Decorate an AppCaller so fn: refs on a machine-bearing app ride the v2
   * box door; every other ref (host tools, fn: on an app that never
   * graduated) keeps the inner caller's behavior.
   */
  wrap(caller: AppCaller): AppCaller;
}

/**
 * Parse one box answer into a tool outcome. Success (2xx) must be exactly a
 * `{result}` JSON envelope — the machine never draws UI in v2, so a `ui`
 * member (or anything else) is a validation error routed to containment.
 */
const outcomeFromBoxAnswer = (status: number, body: Uint8Array): ToolOutcome => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(body)) as unknown;
  } catch {
    return status >= 200 && status < 300
      ? errorOutcome("validation", "machine response is not valid JSON")
      : errorOutcome("machine", `machine function failed (${status})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return status >= 200 && status < 300
      ? errorOutcome("validation", "machine response must be an object envelope")
      : errorOutcome("machine", `machine function failed (${status})`);
  }
  const envelope = parsed as Record<string, unknown>;
  if (status >= 200 && status < 300) {
    if (!own(envelope, "result") || own(envelope, "ui")) {
      return errorOutcome("validation", "machine success response must be exactly a {result} envelope — the machine never draws UI");
    }
    return { status: "ok", output: envelope.result as Json };
  }
  const error = envelope.error;
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const candidate = error as Record<string, unknown>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return errorOutcome(candidate.code, candidate.message);
    }
  }
  return errorOutcome("machine", `machine function failed (${status})`);
};

export const createFnCaller = (config: FnCallerConfig): FnCaller => {
  const callFn = async (
    app: AppDocument,
    name: string,
    args: Json,
    _ctx: RunContext,
  ): Promise<ToolOutcome> => {
    if (!FN_NAME_PATTERN.test(name) || app.machine === undefined) {
      return fnOutcome(name);
    }
    try {
      const machine = await config.wake(app);
      // A memory-snapshot resume boots the app fresh; retry the provider's
      // "port not open" (502/503) for a short window so a fn call right after
      // a wake does not race the app's startup.
      const answer = await requestAppWithBootRetry(machine, {
        method: "POST",
        path: `/fn/${name}`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args }),
      }, config.bootRetry ?? {});
      return outcomeFromBoxAnswer(answer.status, answer.body);
    } catch (error) {
      // Containment: wake and transport failures surface as error outcomes
      // (VendoError codes kept — sandbox-unavailable stays diagnosable).
      if (error instanceof VendoError) return errorOutcome(error.code, error.message);
      return errorOutcome("machine", error instanceof Error ? error.message : "machine function failed");
    }
  };

  return {
    callFn,
    wrap: (inner) => ({
      async call(app, ref, args, ctx) {
        if (ref.startsWith("fn:") && app.machine !== undefined) {
          return callFn(app, ref.slice(3), args, ctx);
        }
        return inner.call(app, ref, args, ctx);
      },
      async callFn(app, name, args, ctx) {
        if (app.machine !== undefined) return callFn(app, name, args, ctx);
        return inner.callFn(app, name, args, ctx);
      },
      async callQuery(app, ref, args, ctx) {
        if (ref.startsWith("fn:") && app.machine !== undefined) {
          return callFn(app, ref.slice(3), args, ctx);
        }
        return inner.callQuery(app, ref, args, ctx);
      },
    }),
  };
};
