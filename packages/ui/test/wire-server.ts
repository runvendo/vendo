import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type {
  AppDocument,
  ApprovalRequest,
  AuditEvent,
  PermissionGrant,
} from "@vendoai/core";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AutomationEntry, RunRecord, Thread, ThreadSummary, VersionEntry } from "../src/index.js";

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  headers: IncomingHttpHeaders;
}

const NOW = "2026-07-11T12:00:00.000Z";

function app(id: string, name: string, automation = false): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name,
    ui: "tree",
    tree: {
      formatVersion: "vendo-genui/v1",
      root: "root",
      nodes: [{ id: "root", component: "Text", props: { text: `${name} app surface` } }],
    },
    ...(automation
      ? { trigger: { on: { kind: "host-event" as const, event: "invoice.created" }, run: { kind: "steps" as const, steps: [] } } }
      : {}),
  };
}

function approval(): ApprovalRequest {
  return {
    id: "apr_1",
    call: { id: "call_1", tool: "host_email_send", args: { to: "a@example.com" } },
    descriptor: {
      name: "host_email_send",
      description: "Send email",
      inputSchema: { type: "object" },
      risk: "write",
    },
    inputPreview: "to a@example.com",
    ctx: {
      principal: { kind: "user", subject: "user_1" },
      venue: "chat",
      presence: "present",
    },
    createdAt: NOW,
  };
}

function grant(): PermissionGrant {
  return {
    id: "grt_1",
    subject: "user_1",
    tool: "host_invoices_list",
    descriptorHash: "sha256:fixture",
    scope: { kind: "tool" },
    duration: "standing",
    source: "chat",
    grantedAt: NOW,
  };
}

function audit(id: string): AuditEvent {
  return {
    id,
    at: NOW,
    kind: "tool-call",
    principal: { kind: "user", subject: "user_1" },
    venue: "chat",
    presence: "present",
    tool: "host_invoices_list",
    outcome: "ok",
  };
}

function run(): RunRecord {
  return {
    id: "run_1",
    appId: "app_auto",
    trigger: { kind: "host-event", event: "invoice.created" },
    status: "running",
    startedAt: NOW,
    steps: [],
  };
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function empty(response: ServerResponse): void {
  response.writeHead(204, { "Content-Length": "0" });
  response.end();
}

function wireError(response: ServerResponse, code: string, message: string, status: number): void {
  json(response, { error: { code, message } }, status);
}

async function bodyBytes(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

async function sendFetchResponse(source: Response, target: ServerResponse): Promise<void> {
  target.writeHead(source.status, Object.fromEntries(source.headers.entries()));
  if (!source.body) {
    target.end();
    return;
  }
  const reader = source.body.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    target.write(Buffer.from(chunk.value));
  }
  target.end();
}

export async function createWireServer() {
  const baseApp = app("app_1", "Invoices");
  const automationApp = app("app_auto", "Invoice watcher", true);
  const existingMessage: UIMessage = {
    id: "msg_existing",
    role: "assistant",
    parts: [{ type: "text", text: "Existing thread" }],
  };
  const state = {
    apps: [baseApp, automationApp],
    approvals: [approval()],
    grants: [grant()],
    automations: [{ app: automationApp, enabled: false }] satisfies AutomationEntry[],
    runs: [run()],
    events: [audit("aud_1"), audit("aud_2"), audit("aud_3")],
    threads: new Map<string, Thread>([
      [
        "thr_1",
        { id: "thr_1", subject: "user_1", messages: [existingMessage], createdAt: NOW, updatedAt: NOW },
      ],
    ]),
    history: [{ at: NOW, intent: "create", rung: 1 }] satisfies VersionEntry[],
    importBytes: new Uint8Array(),
    statusErrorCode: undefined as string | undefined,
    failures: [] as Array<{ method: string; path: string; code: string; message: string; status: number }>,
    posture: "rules" as "unconfigured" | "rules" | "judge" | "rules+judge",
    threadReplyGate: undefined as Promise<void> | undefined,
  };
  const requests: RecordedRequest[] = [];
  let closed = false;

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const contentType = request.headers["content-type"] ?? "";
      const binary = method === "POST" && url.pathname === "/apps/import";
      const raw = method === "GET" ? new Uint8Array() : await bodyBytes(request);
      let parsedBody: unknown = undefined;
      if (raw.byteLength > 0) {
        parsedBody = binary ? Array.from(raw) : JSON.parse(new TextDecoder().decode(raw));
      }
      requests.push({ method, path: `${url.pathname}${url.search}`, body: parsedBody, headers: request.headers });

      const mutating = method !== "GET" && !binary && !url.pathname.startsWith("/webhooks/") && url.pathname !== "/tick";
      if (mutating && !contentType.toLowerCase().startsWith("application/json")) {
        wireError(response, "validation", "JSON content type required", 400);
        return;
      }

      const failureIndex = state.failures.findIndex(failure => failure.method === method && failure.path === url.pathname);
      if (failureIndex >= 0) {
        const [failure] = state.failures.splice(failureIndex, 1);
        wireError(response, failure!.code, failure!.message, failure!.status);
        return;
      }

      if (method === "POST" && url.pathname === "/threads") {
        const input = parsedBody as { threadId?: string; message: UIMessage };
        const threadId = input.threadId ?? "thr_minted";
        const chunks = createUIMessageStream<UIMessage>({
          originalMessages: [input.message],
          generateId: () => "msg_assistant",
          execute: async ({ writer }) => {
            writer.write({
              type: "tool-input-available",
              toolCallId: "call_stream",
              toolName: "host_email_send",
              input: { to: "a@example.com" },
              dynamic: true,
            });
            writer.write({ type: "tool-approval-request", toolCallId: "call_stream", approvalId: "apr_stream" });
            writer.write({
              type: "data-vendo-approval",
              data: { toolCallId: "call_stream", risk: "write", approvalId: "apr_stream" },
            } as UIMessageChunk);
            await state.threadReplyGate;
            writer.write({ type: "text-start", id: "text_1" });
            writer.write({ type: "text-delta", id: "text_1", delta: "Turn complete" });
            writer.write({ type: "text-end", id: "text_1" });
          },
        });
        const streamResponse = createUIMessageStreamResponse({ stream: chunks });
        streamResponse.headers.set("x-vendo-thread-id", threadId);
        await sendFetchResponse(streamResponse, response);
        return;
      }

      if (method === "GET" && url.pathname === "/threads") {
        const summaries: ThreadSummary[] = [...state.threads.values()].map(thread => ({
          id: thread.id,
          title: "Fixture thread",
          updatedAt: thread.updatedAt,
        }));
        json(response, summaries);
        return;
      }
      const threadMatch = url.pathname.match(/^\/threads\/([^/]+)$/);
      if (threadMatch) {
        const id = decodeURIComponent(threadMatch[1] ?? "");
        const thread = state.threads.get(id);
        if (!thread) return wireError(response, "not-found", "Thread not found", 404);
        if (method === "GET") return json(response, thread);
        if (method === "DELETE") {
          state.threads.delete(id);
          return empty(response);
        }
      }

      if (method === "GET" && url.pathname === "/approvals") return json(response, state.approvals);
      if (method === "POST" && url.pathname === "/approvals/decide") {
        const ids = (parsedBody as { ids: string[] }).ids;
        if (ids.some(id => !state.approvals.some(item => item.id === id))) {
          return wireError(response, "not-found", "Approval not found", 404);
        }
        state.approvals = state.approvals.filter(item => !ids.includes(item.id));
        return empty(response);
      }
      if (method === "GET" && url.pathname === "/grants") return json(response, state.grants);
      const grantMatch = url.pathname.match(/^\/grants\/([^/]+)$/);
      if (method === "DELETE" && grantMatch) {
        const id = decodeURIComponent(grantMatch[1] ?? "");
        if (!state.grants.some(item => item.id === id)) return wireError(response, "not-found", "Grant not found", 404);
        state.grants = state.grants.filter(item => item.id !== id);
        return empty(response);
      }

      if (url.pathname === "/apps" && method === "GET") return json(response, state.apps);
      if (url.pathname === "/apps" && method === "POST") {
        const created = app(`app_${state.apps.length + 1}`, (parsedBody as { prompt: string }).prompt);
        state.apps.push(created);
        return json(response, created);
      }
      if (url.pathname === "/apps/import" && method === "POST") {
        state.importBytes = raw;
        const imported = app("app_imported", "Imported");
        state.apps.push(imported);
        return json(response, imported);
      }
      const exportMatch = url.pathname.match(/^\/apps\/([^/]+)\/export$/);
      if (method === "GET" && exportMatch) {
        const id = decodeURIComponent(exportMatch[1] ?? "");
        if (!state.apps.some(item => item.id === id)) return wireError(response, "not-found", "App not found", 404);
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end(Buffer.from([0, 1, 255]));
        return;
      }
      const appActionMatch = url.pathname.match(/^\/apps\/([^/]+)\/(open|call|edit|history|fork)$/);
      if (appActionMatch) {
        const id = decodeURIComponent(appActionMatch[1] ?? "");
        const action = appActionMatch[2];
        const index = state.apps.findIndex(item => item.id === id);
        if (index < 0) return wireError(response, "not-found", "App not found", 404);
        if (action === "open" && method === "GET") {
          return json(response, { kind: "tree", payload: state.apps[index]?.tree });
        }
        if (action === "call" && method === "POST") return json(response, { status: "ok", output: parsedBody });
        if (action === "edit" && method === "POST") {
          const edited = { ...state.apps[index]!, name: "Edited" };
          state.apps[index] = edited;
          const version = { at: NOW, intent: (parsedBody as { instruction: string }).instruction, rung: 2 as const };
          state.history.push(version);
          return json(response, { app: edited, version });
        }
        if (action === "history" && method === "GET") return json(response, state.history);
        if (action === "history" && method === "POST") {
          const undone = { ...state.apps[index]!, name: "Undone" };
          state.apps[index] = undone;
          return json(response, undone);
        }
        if (action === "fork" && method === "POST") {
          const forked = { ...state.apps[index]!, id: `app_fork_${state.apps.length}`, forkedFrom: id };
          state.apps.push(forked);
          return json(response, forked);
        }
      }
      const appMatch = url.pathname.match(/^\/apps\/([^/]+)$/);
      if (appMatch) {
        const id = decodeURIComponent(appMatch[1] ?? "");
        const index = state.apps.findIndex(item => item.id === id);
        if (index < 0) return wireError(response, "not-found", "App not found", 404);
        if (method === "GET") return json(response, state.apps[index]);
        if (method === "DELETE") {
          state.apps.splice(index, 1);
          return empty(response);
        }
      }

      if (method === "GET" && url.pathname === "/automations") return json(response, state.automations);
      const automationMatch = url.pathname.match(/^\/automations\/([^/]+)\/(enable|disable|dry-run)$/);
      if (method === "POST" && automationMatch) {
        const id = decodeURIComponent(automationMatch[1] ?? "");
        const entry = state.automations.find(item => item.app.id === id);
        if (!entry) return wireError(response, "not-found", "Automation not found", 404);
        const action = automationMatch[2];
        if (action === "enable") {
          entry.enabled = true;
          return json(response, { enabled: true, missing: [approval()] });
        }
        if (action === "disable") {
          entry.enabled = false;
          return empty(response);
        }
        return json(response, { steps: [{ id: "step_1", tool: "host_invoices_list", wouldAsk: false }], grantsMissing: [] });
      }

      if (method === "GET" && url.pathname === "/runs") {
        const appId = url.searchParams.get("appId");
        const status = url.searchParams.get("status");
        return json(response, {
          runs: state.runs.filter(item => (!appId || item.appId === appId) && (!status || item.status === status)),
          ...(url.searchParams.get("cursor") ? {} : { cursor: "run_cursor" }),
        });
      }
      const runStopMatch = url.pathname.match(/^\/runs\/([^/]+)\/stop$/);
      if (method === "POST" && runStopMatch) {
        const item = state.runs.find(candidate => candidate.id === decodeURIComponent(runStopMatch[1] ?? ""));
        if (!item) return wireError(response, "not-found", "Run not found", 404);
        item.status = "stopped";
        return empty(response);
      }
      const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (method === "GET" && runMatch) {
        const item = state.runs.find(candidate => candidate.id === decodeURIComponent(runMatch[1] ?? ""));
        return item ? json(response, item) : wireError(response, "not-found", "Run not found", 404);
      }

      if (method === "GET" && url.pathname === "/activity") {
        const cursor = url.searchParams.get("cursor");
        return json(response, cursor ? state.events.slice(1) : state.events.slice(0, 2));
      }
      if (method === "GET" && url.pathname === "/status") {
        if (state.statusErrorCode) return wireError(response, state.statusErrorCode, "Status failed", 501);
        // A client may force a posture via header (harness: one surface shows the
        // no-policy notice while the rest render as a configured host).
        const forced = request.headers["x-vendo-force-posture"];
        const posture = typeof forced === "string" ? forced : state.posture;
        return json(response, { posture, version: "0.3.0", blocks: { guard: true } });
      }
      if (method === "POST" && url.pathname === "/tick") return json(response, []);
      if (method === "POST" && url.pathname.startsWith("/webhooks/")) return json(response, { accepted: true });

      wireError(response, "not-found", "Route not found", 404);
    } catch (error) {
      wireError(response, "validation", error instanceof Error ? error.message : "Invalid request", 400);
    }
  };
  const server = createServer(handler);
  const originalFetch = globalThis.fetch;
  let fallback = false;
  let port = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    port = (server.address() as AddressInfo).port;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
    fallback = true;
    port = 49_321;
  }

  const url = `http://127.0.0.1:${port}`;
  if (fallback) {
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = input instanceof Request ? input.url : String(input);
      if (!target.startsWith(url)) return originalFetch(input, init);

      const safeInit = init === undefined ? undefined : { ...init, signal: undefined };
      const fetchRequest = input instanceof Request && init === undefined ? input : new Request(target, safeInit);
      const raw = new Uint8Array(await fetchRequest.arrayBuffer());
      const requestHeaders = Object.fromEntries(fetchRequest.headers.entries());
      const mockRequest = {
        method: fetchRequest.method,
        url: `${new URL(target).pathname}${new URL(target).search}`,
        headers: requestHeaders,
        async *[Symbol.asyncIterator]() {
          if (raw.byteLength > 0) yield Buffer.from(raw);
        },
      } as unknown as IncomingMessage;
      let status = 200;
      let responseHeaders: Record<string, string | number | readonly string[]> = {};
      const chunks: Buffer[] = [];
      const mockResponse = {
        writeHead(nextStatus: number, nextHeaders?: Record<string, string | number | readonly string[]>) {
          status = nextStatus;
          responseHeaders = nextHeaders ?? {};
          return this;
        },
        write(chunk: Uint8Array | string) {
          chunks.push(Buffer.from(chunk));
          return true;
        },
        end(chunk?: Uint8Array | string) {
          if (chunk !== undefined) chunks.push(Buffer.from(chunk));
          return this;
        },
      } as unknown as ServerResponse;

      await handler(mockRequest, mockResponse);
      const normalizedHeaders = new Headers();
      for (const [name, value] of Object.entries(responseHeaders)) {
        if (value !== undefined) normalizedHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      }
      return new Response(status === 204 ? null : Buffer.concat(chunks), { status, headers: normalizedHeaders });
    };
  }

  return {
    url,
    state,
    requests,
    close: async () => {
      if (closed) return;
      closed = true;
      if (fallback) {
        globalThis.fetch = originalFetch;
        return;
      }
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    },
  };
}
