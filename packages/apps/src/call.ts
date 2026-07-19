import {
  VENDO_TREE_FORMAT_V2,
  VendoError,
  validateTreeV2,
  type AppDocument,
  type Json,
  type RunContext,
  type ToolOutcome,
  type ToolRegistry,
  type UIPayload,
} from "@vendoai/core";
import type { MachineAuthorization, MachineRun, MachineSessions } from "./machine.js";

const FN_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const decoder = new TextDecoder();

const validationError = (message: string): ToolOutcome => ({
  status: "error",
  error: { code: "validation", message },
});

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const validatedUi = (input: unknown): UIPayload | null => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const candidate = input as UIPayload;
  if (candidate.formatVersion !== VENDO_TREE_FORMAT_V2) return null;
  // A server-computed payload may carry components beside the tree fields
  // (the renderer lifts them and the jail enforces the component caps); the
  // canonical tree validates without them.
  const { components: _components, ...tree } = candidate as UIPayload & { components?: unknown };
  const result = validateTreeV2(tree);
  return result.ok ? candidate : null;
};

/** 06-apps §4.1 — internal execution surface shared by open() and call(). */
export interface AppCaller {
  call(
    app: AppDocument,
    ref: string,
    args: Json,
    ctx: RunContext,
    authorization?: MachineAuthorization,
  ): Promise<ToolOutcome>;
  callFn(
    app: AppDocument,
    name: string,
    args: Json,
    ctx: RunContext,
    authorization?: MachineAuthorization,
  ): Promise<ToolOutcome>;
  callQuery(
    app: AppDocument,
    ref: string,
    args: Json,
    ctx: RunContext,
    authorization?: MachineAuthorization,
  ): Promise<{ outcome: ToolOutcome; uiEnvelope: boolean }>;
}

/** 06-apps §4.1 — resolve machine functions and guard-bound host tools. */
export const createAppCaller = (machines: MachineSessions, tools: ToolRegistry): AppCaller => {
  const executeFn = async (
    app: AppDocument,
    name: string,
    args: Json,
    ctx: RunContext,
    authorization?: MachineAuthorization,
  ): Promise<{ outcome: ToolOutcome; uiEnvelope: boolean }> => {
    if (!FN_PATTERN.test(name)) {
      return { outcome: validationError(`invalid fn reference: fn:${name}`), uiEnvelope: false };
    }
    if (!machines.available()) {
      throw new VendoError("sandbox-unavailable", "sandbox execution is unavailable");
    }
    if (app.server === undefined) {
      return { outcome: validationError(`fn:${name} requires an app server`), uiEnvelope: false };
    }

    try {
      const requestMachine = async ({ machine, runToken }: MachineRun) => machine.request({
        method: "POST",
        path: `/fn/${name}`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${runToken}`,
        },
        body: JSON.stringify({ args }),
      });
      const response = authorization === undefined
        ? await machines.withMachine(app, ctx, requestMachine)
        : await machines.withAuthorization(app, ctx, authorization, requestMachine);
      return await (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(decoder.decode(response.body)) as unknown;
        } catch {
          return { outcome: validationError("machine response is not valid JSON"), uiEnvelope: false };
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return { outcome: validationError("machine response must be an object envelope"), uiEnvelope: false };
        }
        const envelope = parsed as Record<string, unknown>;
        if (response.status >= 200 && response.status < 300) {
          const hasResult = own(envelope, "result");
          const hasUi = own(envelope, "ui");
          if (hasResult === hasUi) {
            return {
              outcome: validationError("machine success response must contain exactly one of result or ui"),
              uiEnvelope: false,
            };
          }
          if (hasResult) return { outcome: { status: "ok", output: envelope.result }, uiEnvelope: false };
          const ui = validatedUi(envelope.ui);
          return ui === null
            ? {
              outcome: validationError("machine returned an invalid or unregistered ui payload"),
              uiEnvelope: true,
            }
            : { outcome: { status: "ok", output: { ui } }, uiEnvelope: true };
        }
        const error = envelope.error;
        if (typeof error === "object" && error !== null && !Array.isArray(error)) {
          const candidate = error as Record<string, unknown>;
          if (typeof candidate.code === "string" && typeof candidate.message === "string") {
            return {
              outcome: { status: "error", error: { code: candidate.code, message: candidate.message } },
              uiEnvelope: false,
            };
          }
        }
        return {
          outcome: {
            status: "error",
            error: { code: "machine", message: `machine function failed (${response.status})` },
          },
          uiEnvelope: false,
        };
      })();
    } catch (error) {
      if (error instanceof VendoError && error.code === "sandbox-unavailable") throw error;
      return {
        outcome: {
          status: "error",
          error: { code: "machine", message: error instanceof Error ? error.message : "machine function failed" },
        },
        uiEnvelope: false,
      };
    }
  };

  const callFn = async (
    app: AppDocument,
    name: string,
    args: Json,
    ctx: RunContext,
    authorization?: MachineAuthorization,
  ): Promise<ToolOutcome> => (await executeFn(app, name, args, ctx, authorization)).outcome;

  return {
    callFn,
    async callQuery(app, ref, args, ctx, authorization) {
      if (ref.startsWith("fn:")) return executeFn(app, ref.slice(3), args, ctx, authorization);
      return {
        outcome: await tools.execute(
          { id: `call_${globalThis.crypto.randomUUID()}`, tool: ref, args },
          { ...ctx, venue: "app", appId: app.id },
        ),
        uiEnvelope: false,
      };
    },
    async call(app, ref, args, ctx, authorization) {
      if (ref.startsWith("fn:")) return callFn(app, ref.slice(3), args, ctx, authorization);
      return tools.execute(
        { id: `call_${globalThis.crypto.randomUUID()}`, tool: ref, args },
        { ...ctx, venue: "app", appId: app.id },
      );
    },
  };
};
