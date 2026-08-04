/**
 * Chip tap interception (demo-hygiene) — the instant-attach half of the "try
 * this" chips. POST /api/vendo/threads calls chipThreadsResponse right after
 * the scripted-demo seam: when the user text exactly matches a chip whose
 * pre-generated app is still in the store, the turn streams that app
 * immediately (same data-vendo-view wire part live generation settles into,
 * no generation wait) and persists to the same vendo_threads row a live turn
 * would. Anything else — unknown prompt, foreign user, erased cache — returns
 * null so the REAL agent generates normally with its normal progress UI.
 */
import { toVendoWirePart, vendoViewStreamId, type Principal, type RunContext } from "@vendoai/core";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { loadScriptedThread, persistScriptedThread, upsertMessage } from "@/demo-script/threads";
import { resolveMapleSession } from "@/vendo/auth";
import { readChipManifest } from "@/vendo/chips";
import { vendo } from "@/vendo/server";

const THREAD_ID_HEADER = "x-vendo-thread-id";

function userText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

export async function chipThreadsResponse(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method !== "POST" || !pathname.endsWith("/api/vendo/threads")) return null;

  let body: { threadId?: string; message?: UIMessage };
  try {
    body = (await request.clone().json()) as typeof body;
  } catch {
    return null;
  }
  const message = body?.message;
  if (!message || message.role !== "user" || !Array.isArray(message.parts)) return null;

  const user = await resolveMapleSession(request);
  if (user === null) return null;
  const text = userText(message);
  const entry = (await readChipManifest(user.subject)).find((chip) => chip.prompt.trim() === text);
  if (entry === undefined) return null;

  const principal: Principal = { kind: "user", subject: user.subject };
  const ctx: RunContext = {
    principal,
    venue: "chat",
    presence: "present",
    sessionId: request.headers.get("x-vendo-session-id") ?? "demo-chips",
    requestHeaders: Object.fromEntries(request.headers.entries()),
  };

  // Cache miss (reset erased the app, pre-generation still running): fall
  // through to the real agent — normal live generation, normal progress UI.
  const app = await vendo.apps.get(entry.appId, ctx).catch(() => null);
  if (app === null) return null;
  const surface = await vendo.apps.open(entry.appId, ctx).catch(() => null);
  if (surface === null || surface.kind !== "tree") return null;

  const thread = await loadScriptedThread(principal, body.threadId);
  upsertMessage(thread.messages, message);
  const payload = { name: app.name, ...surface.payload };

  const stream = createUIMessageStream<UIMessage>({
    originalMessages: thread.messages,
    execute: async ({ writer }) => {
      const write = (chunk: UIMessageChunk): void => writer.write(chunk as never);
      write({ type: "start", messageId: `msg_chip_${globalThis.crypto.randomUUID().slice(0, 12)}` });
      // The settled payload lands in one part — the app card attaches
      // instantly, exactly what "pre-generated" promises.
      write(toVendoWirePart(
        { type: "data-vendo-view", appId: entry.appId, payload },
        vendoViewStreamId(entry.appId as never),
      ) as UIMessageChunk);
      const id = `txt_${globalThis.crypto.randomUUID().slice(0, 8)}`;
      write({ type: "text-start", id });
      write({ type: "text-delta", id, delta: "Already built this one — it's yours to keep or pin." });
      write({ type: "text-end", id });
    },
    onFinish: async ({ messages }) => {
      await persistScriptedThread(principal, thread.id, messages);
    },
    onError: () => "An error occurred while attaching the app.",
  });
  const response = createUIMessageStreamResponse({ stream });
  response.headers.set(THREAD_ID_HEADER, thread.id);
  return response;
}
