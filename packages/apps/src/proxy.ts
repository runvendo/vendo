import type { AppId, RunContext, ToolRegistry } from "@vendoai/core";
import type { AppDataAccess } from "./app-data.js";
import { verifyRunToken, type RunTokenSecret } from "./run-token.js";

const STATE_BODY_MAX_BYTES = 256 * 1024;
const decoder = new TextDecoder();

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const errorResponse = (status: number, code: string, message: string): Response =>
  jsonResponse({ error: { code, message } }, status);

const isJson = (request: Request): boolean => {
  const contentType = request.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
};

const bearerToken = (request: Request): string | null => {
  const authorization = request.headers.get("authorization");
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match?.[1] ?? null;
};

/** 06-apps §4.4 — internal dependencies for the fetch-style proxy. */
export interface AppsProxyDependencies {
  tokenSecret: RunTokenSecret;
  tools: ToolRegistry;
  data: AppDataAccess;
  owns(appId: AppId, subject: string): Promise<boolean>;
}

/** 06-apps §4.4 and plan decision 3 — fetch-style machine capability proxy. */
export const createAppsProxy = (dependencies: AppsProxyDependencies): { handler(request: Request): Promise<Response> } => ({
  async handler(request) {
    const url = new URL(request.url);
    const toolMatch = /^\/tools\/([a-zA-Z0-9_-]{1,64})$/.exec(url.pathname);
    const isTool = request.method === "POST" && toolMatch?.[1] !== undefined;
    const isStateGet = request.method === "GET" && url.pathname === "/state";
    const isStatePut = request.method === "PUT" && url.pathname === "/state";
    if (!isTool && !isStateGet && !isStatePut) {
      return errorResponse(404, "not-found", "unknown proxy route");
    }
    if ((isTool || isStatePut) && !isJson(request)) {
      return errorResponse(400, "validation", "content-type must be application/json");
    }
    const token = bearerToken(request);
    const payload = token === null ? null : await verifyRunToken(dependencies.tokenSecret, token);
    if (payload === null) return errorResponse(401, "unauthorized", "invalid or expired run token");
    if (!await dependencies.owns(payload.appId, payload.subject)) {
      return errorResponse(404, "not-found", "app not found");
    }
    const runCtx: RunContext = {
      principal: { kind: "user", subject: payload.subject },
      venue: "app",
      presence: payload.presence,
      sessionId: payload.runId,
      appId: payload.appId,
    };

    if (isStateGet) {
      return jsonResponse(await dependencies.data.getState(payload.appId, payload.subject));
    }
    let body: unknown;
    try {
      if (isStatePut) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength > STATE_BODY_MAX_BYTES) {
          return errorResponse(400, "validation", "request body exceeds size limit");
        }
        body = JSON.parse(decoder.decode(bytes)) as unknown;
      } else {
        body = await request.json();
      }
    } catch {
      return errorResponse(400, "validation", "request body must be valid JSON");
    }
    if (isStatePut) {
      await dependencies.data.setState(payload.appId, payload.subject, body);
      return jsonResponse({ status: "ok" });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)
      || !Object.prototype.hasOwnProperty.call(body, "args")) {
      return errorResponse(400, "validation", "tool body must be an object containing args");
    }
    const tool = toolMatch?.[1];
    if (tool === undefined) return errorResponse(404, "not-found", "unknown proxy route");
    const outcome = await dependencies.tools.execute({
      id: `call_${globalThis.crypto.randomUUID()}`,
      tool,
      args: (body as { args: unknown }).args,
    }, runCtx);
    return jsonResponse(outcome);
  },
});
