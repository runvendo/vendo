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
    connections: [
      { id: "ca_1", connector: "composio", toolkit: "gmail", status: "active" as const, createdAt: NOW },
    ],
    // block-actions §C — org workspaces. `orgsGated` simulates the key-gated
    // posture (no VENDO_API_KEY): every /orgs route returns cloud-required.
    orgsGated: false,
    orgs: [
      { id: "org_1", name: "Acme Corp", createdAt: NOW, updatedAt: NOW },
    ],
    orgMembers: [
      { orgId: "org_1", subject: "user_1", role: "owner" as "owner" | "admin" | "member", addedAt: NOW },
      { orgId: "org_1", subject: "user_bob", role: "member" as "owner" | "admin" | "member", addedAt: NOW },
    ],
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
    // ENG-214 — how many upcoming /threads turns die MID-stream (a partial
    // delta lands, then the stream errors the way a dropped connection
    // surfaces client-side). A counter rather than a text marker so a retry
    // of the SAME user message can succeed.
    streamFailures: 0,
    posture: "rules" as "unconfigured" | "rules" | "judge" | "rules+judge",
    threadReplyGate: undefined as Promise<void> | undefined,
    // ENG-217 — optional pacing gates for the canned turn so specs can observe
    // exact streaming moments: before ANY chunk (generating skeleton), after
    // text-start but before the first delta (lone caret on an empty streamed
    // turn), and between deltas (trailing caret on flowing text). All default
    // undefined: awaiting undefined is a no-op for every existing consumer.
    turnStartGate: undefined as Promise<void> | undefined,
    textStartGate: undefined as Promise<void> | undefined,
    textMidGate: undefined as Promise<void> | undefined,
  };
  const requests: RecordedRequest[] = [];
  let closed = false;
  // Multi-turn sessions (ENG-221 reopen tests) must not mint colliding
  // message/approval ids — duplicate React keys. Turn 1 keeps the historical
  // bare ids so single-turn assertions stay stable.
  let turns = 0;

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
        let threadId = input.threadId ?? "thr_minted";
        // ENG-222 — persist a freshly minted conversation so a subsequent
        // GET /threads (the sidebar refresh) actually surfaces it. The first new
        // conversation keeps the historical "thr_minted" id (single-turn specs
        // rely on it); a second brand-new conversation in the same server gets a
        // fresh unique id, so each "New conversation" truly adds a sidebar entry.
        if (input.threadId === undefined) {
          if (state.threads.has(threadId)) {
            let index = 2;
            while (state.threads.has(`thr_minted_${index}`)) index += 1;
            threadId = `thr_minted_${index}`;
          }
          state.threads.set(threadId, {
            id: threadId,
            subject: "user_1",
            messages: [input.message],
            createdAt: NOW,
            // A minted conversation is the newest: stamp it AFTER the seeded
            // NOW so GET /threads (sorted newest-first) surfaces it at the top,
            // where the workspace sidebar defaults its selection (ENG-231).
            updatedAt: new Date(Date.parse(NOW) + state.threads.size * 1000).toISOString(),
          });
        }
        const suffix = ++turns === 1 ? "" : `_${turns}`;
        // ENG-213 — a paced long-form stream so real-browser specs can observe
        // scroll behavior MID-stream (stick-to-bottom, scroll-up release, the
        // jump-to-latest pill). Opt-in per message via a marker, so every
        // existing consumer of the instant canned turn is untouched.
        const sentText = input.message.parts
          .map(part => (part.type === "text" ? part.text : ""))
          .join(" ");
        if (state.streamFailures > 0) {
          state.streamFailures -= 1;
          const failingChunks = createUIMessageStream<UIMessage>({
            originalMessages: [input.message],
            generateId: () => `msg_assistant_fail${suffix}`,
            execute: async ({ writer }) => {
              writer.write({ type: "text-start", id: "text_fail" });
              writer.write({ type: "text-delta", id: "text_fail", delta: "Starting an answer that will be cut" });
              throw new Error("connection reset mid-stream");
            },
            onError: error => (error instanceof Error ? error.message : String(error)),
          });
          const failingResponse = createUIMessageStreamResponse({ stream: failingChunks });
          failingResponse.headers.set("x-vendo-thread-id", threadId);
          await sendFetchResponse(failingResponse, response);
          return;
        }
        if (sentText.includes("[stream-kill]")) {
          // ENG-231 — a turn that streams a partial delta then drops the
          // connection mid-stream, so a real-browser stress spec can drive the
          // visible error banner + Retry (the ENG-214 recovery UX). Opt-in via
          // the marker only; the deterministic suite is untouched.
          const killChunks = createUIMessageStream<UIMessage>({
            originalMessages: [input.message],
            generateId: () => "msg_assistant_kill",
            execute: async ({ writer }) => {
              writer.write({ type: "text-start", id: "text_kill" });
              writer.write({ type: "text-delta", id: "text_kill", delta: "Starting an answer that will be cut" });
              throw new Error("connection reset mid-stream");
            },
            onError: error => (error instanceof Error ? error.message : String(error)),
          });
          const killResponse = createUIMessageStreamResponse({ stream: killChunks });
          killResponse.headers.set("x-vendo-thread-id", threadId);
          await sendFetchResponse(killResponse, response);
          return;
        }
        if (sentText.includes("[stream-hang]")) {
          // ENG-215 — a turn that starts streaming then holds the connection
          // open indefinitely, so a real-browser capture has unlimited time to
          // observe the mid-stream composer (queued-send pill, Stop, live input).
          // Never used by the deterministic suite; opt-in via the marker only.
          const hangChunks = createUIMessageStream<UIMessage>({
            originalMessages: [input.message],
            generateId: () => "msg_assistant_hang",
            execute: async ({ writer }) => {
              writer.write({ type: "text-start", id: "text_hang" });
              writer.write({ type: "text-delta", id: "text_hang", delta: "Working on the welcome flow" });
              await new Promise<void>(() => undefined);
            },
          });
          const hangResponse = createUIMessageStreamResponse({ stream: hangChunks });
          hangResponse.headers.set("x-vendo-thread-id", threadId);
          await sendFetchResponse(hangResponse, response);
          return;
        }
        if (sentText.includes("[stream-long]")) {
          const longChunks = createUIMessageStream<UIMessage>({
            originalMessages: [input.message],
            generateId: () => "msg_assistant_long",
            execute: async ({ writer }) => {
              writer.write({ type: "text-start", id: "text_long" });
              // ~8s of pacing: long enough that a spec can act mid-stream (scroll
              // up, watch for yanking, click the pill) even on a loaded CI worker.
              for (let index = 0; index < 100; index += 1) {
                writer.write({
                  type: "text-delta",
                  id: "text_long",
                  delta: `Streamed paragraph ${index + 1}: the long answer keeps arriving so the list keeps growing while the reader watches.\n\n`,
                });
                await new Promise(resolve => setTimeout(resolve, 80));
              }
              writer.write({ type: "text-delta", id: "text_long", delta: "Long turn complete." });
              writer.write({ type: "text-end", id: "text_long" });
            },
          });
          const longResponse = createUIMessageStreamResponse({ stream: longChunks });
          longResponse.headers.set("x-vendo-thread-id", threadId);
          await sendFetchResponse(longResponse, response);
          return;
        }
        const chunks = createUIMessageStream<UIMessage>({
          originalMessages: [input.message],
          generateId: () => `msg_assistant${suffix}`,
          execute: async ({ writer }) => {
            await state.turnStartGate;
            writer.write({
              type: "tool-input-available",
              toolCallId: `call_stream${suffix}`,
              toolName: "host_email_send",
              input: { to: "a@example.com" },
              dynamic: true,
            });
            writer.write({ type: "tool-approval-request", toolCallId: `call_stream${suffix}`, approvalId: `apr_stream${suffix}` });
            writer.write({
              type: "data-vendo-approval",
              data: {
                toolCallId: `call_stream${suffix}`,
                risk: "write",
                approvalId: `apr_stream${suffix}`,
                invalidatedGrant: {
                  id: "grt_stale",
                  grantedAt: "2026-07-01T12:00:00.000Z",
                },
              },
            } as UIMessageChunk);
            await state.threadReplyGate;
            writer.write({ type: "text-start", id: "text_1" });
            await state.textStartGate;
            writer.write({ type: "text-delta", id: "text_1", delta: "Turn " });
            await state.textMidGate;
            writer.write({ type: "text-delta", id: "text_1", delta: "complete" });
            writer.write({ type: "text-end", id: "text_1" });
          },
        });
        const streamResponse = createUIMessageStreamResponse({ stream: chunks });
        streamResponse.headers.set("x-vendo-thread-id", threadId);
        await sendFetchResponse(streamResponse, response);
        return;
      }

      if (method === "GET" && url.pathname === "/threads") {
        // Newest-first, as a real store returns them — the workspace sidebar
        // defaults its selection to threads[0], so a just-minted conversation
        // must sort to the top (ENG-231 persistence guard).
        const summaries: ThreadSummary[] = [...state.threads.values()]
          .map(thread => ({ id: thread.id, title: "Fixture thread", updatedAt: thread.updatedAt }))
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
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
      if (method === "GET" && url.pathname === "/connections") {
        return json(response, { connections: state.connections });
      }
      if (method === "POST" && url.pathname === "/connections/initiate") {
        // The freshly initiated account is immediately pollable and flips
        // active on first read (the shortest honest OAuth completion). Honors
        // the requested toolkit so multi-connector surfaces (the ENG-225
        // connect tray) see the account they asked for.
        const initiateBody = parsedBody as { toolkit?: string; connector?: string };
        if (!state.connections.some(item => item.id === "ca_new")) {
          state.connections.push({
            id: "ca_new",
            connector: initiateBody.connector ?? "composio",
            toolkit: initiateBody.toolkit ?? "gmail",
            status: "active",
            createdAt: NOW,
          });
        }
        return json(response, { id: "ca_new", connector: initiateBody.connector ?? "composio", redirectUrl: "https://connect.test/oauth/1" });
      }
      const connectionMatch = url.pathname.match(/^\/connections\/([^/]+)$/);
      if (connectionMatch) {
        const id = decodeURIComponent(connectionMatch[1]!);
        const found = state.connections.find(item => item.id === id);
        if (method === "GET") {
          if (!found) return wireError(response, "not-found", "Connection not found", 404);
          return json(response, found);
        }
        if (method === "DELETE") {
          if (!found) return wireError(response, "not-found", "Connection not found", 404);
          state.connections = state.connections.filter(item => item.id !== id);
          return json(response, {});
        }
      }
      if (url.pathname === "/orgs" || url.pathname.startsWith("/orgs/")) {
        // A client may force the key-gated posture via header (harness: the
        // gated scenario renders the upgrade state, same trick as force-posture).
        if (state.orgsGated || request.headers["x-vendo-force-orgs-gated"] === "1") {
          return wireError(response, "cloud-required", "orgs are a Vendo Cloud capability: set VENDO_API_KEY (get one at vendo.run) to activate org workspaces", 402);
        }
        if (method === "GET" && url.pathname === "/orgs") {
          return json(response, {
            orgs: state.orgs.map(org => ({
              ...org,
              role: state.orgMembers.find(member => member.orgId === org.id && member.subject === "user_1")?.role ?? "member",
            })),
            posture: "cloud",
          });
        }
        if (method === "POST" && url.pathname === "/orgs") {
          const name = (parsedBody as { name: string }).name;
          const org = { id: `org_${state.orgs.length + 1}`, name, createdAt: NOW, updatedAt: NOW };
          state.orgs.push(org);
          state.orgMembers.push({ orgId: org.id, subject: "user_1", role: "owner", addedAt: NOW });
          return json(response, org);
        }
        const orgGet = url.pathname.match(/^\/orgs\/([^/]+)$/);
        if (method === "GET" && orgGet) {
          const org = state.orgs.find(item => item.id === decodeURIComponent(orgGet[1]!));
          if (!org) return wireError(response, "not-found", "org not found", 404);
          const members = state.orgMembers.filter(member => member.orgId === org.id);
          const role = members.find(member => member.subject === "user_1")?.role ?? "member";
          return json(response, { org, role, members });
        }
        const orgMembersMatch = url.pathname.match(/^\/orgs\/([^/]+)\/members$/);
        if (method === "POST" && orgMembersMatch) {
          const orgId = decodeURIComponent(orgMembersMatch[1]!);
          const body = parsedBody as { subject: string; role?: "owner" | "admin" | "member" };
          if (state.orgMembers.some(member => member.orgId === orgId && member.subject === body.subject)) {
            return wireError(response, "conflict", "already a member", 409);
          }
          const member = { orgId, subject: body.subject, role: body.role ?? "member" as const, addedAt: NOW };
          state.orgMembers.push(member);
          return json(response, member);
        }
        const orgMemberMatch = url.pathname.match(/^\/orgs\/([^/]+)\/members\/([^/]+)$/);
        if (orgMemberMatch) {
          const orgId = decodeURIComponent(orgMemberMatch[1]!);
          const subject = decodeURIComponent(orgMemberMatch[2]!);
          const member = state.orgMembers.find(item => item.orgId === orgId && item.subject === subject);
          if (!member) return wireError(response, "not-found", "not a member", 404);
          if (method === "PATCH") {
            member.role = (parsedBody as { role: "owner" | "admin" | "member" }).role;
            return json(response, member);
          }
          if (method === "DELETE") {
            state.orgMembers = state.orgMembers.filter(item => item !== member);
            return json(response, {});
          }
        }
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
