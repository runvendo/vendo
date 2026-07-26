/**
 * Chip tap interception (demo-hygiene) — the instant-attach half of the "try
 * this" chips, mirroring demo-bank's module. POST /api/vendo/threads calls
 * chipThreadsResponse first: when the user text exactly matches a chip whose
 * pre-generated app is still in the store, the turn streams that app
 * immediately (same data-vendo-view wire part live generation settles into)
 * and persists to the same vendo_threads row a live turn would. Anything
 * else — unknown prompt, foreign user, erased cache — returns null so the
 * REAL agent generates normally with its normal progress UI.
 */
import { toVendoWirePart, vendoViewStreamId, type Json, type Principal, type RunContext } from "@vendoai/core"
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai"
import { resolveCadenceSession } from "@/server/session"
import { readChipManifest } from "./chips"
import { vendo } from "./server"

const THREAD_ID_HEADER = "x-vendo-thread-id"

function userText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map(part => part.text)
    .join("")
    .trim()
}

function mintThreadId(): string {
  return `thr_${globalThis.crypto.randomUUID().replaceAll("-", "")}`
}

/** Load (or mint) the thread for this turn, scoped to the caller's subject —
 * the same reserved vendo_threads rows the real agent reads and writes. */
async function loadThread(
  principal: Principal,
  threadId: string | undefined,
): Promise<{ id: string; messages: UIMessage[] }> {
  if (threadId === undefined) return { id: mintThreadId(), messages: [] }
  const record = await vendo.store.records("vendo_threads").get(threadId)
  const data = record?.data as { subject?: string; messages?: Json[] } | undefined
  if (record === null || data?.subject !== principal.subject) return { id: threadId, messages: [] }
  return { id: record.id, messages: (data.messages ?? []) as unknown as UIMessage[] }
}

async function persistThread(principal: Principal, id: string, messages: UIMessage[]): Promise<void> {
  const plain = JSON.parse(JSON.stringify(messages)) as Json[]
  await vendo.store.records("vendo_threads").put({
    id,
    data: { subject: principal.subject, messages: plain },
  })
}

export async function chipThreadsResponse(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url)
  if (request.method !== "POST" || !pathname.endsWith("/api/vendo/threads")) return null

  let body: { threadId?: string; message?: UIMessage }
  try {
    body = (await request.clone().json()) as typeof body
  } catch {
    return null
  }
  const message = body?.message
  if (!message || message.role !== "user" || !Array.isArray(message.parts)) return null

  const session = await resolveCadenceSession(request)
  if (session === null) return null
  const text = userText(message)
  const entry = (await readChipManifest(session.subject)).find(chip => chip.prompt.trim() === text)
  if (entry === undefined) return null

  const principal: Principal = { kind: "user", subject: session.subject }
  const ctx: RunContext = {
    principal,
    venue: "chat",
    presence: "present",
    sessionId: request.headers.get("x-vendo-session-id") ?? "demo-chips",
    requestHeaders: Object.fromEntries(request.headers.entries()),
  }

  // Cache miss (pre-generation still running, or the app was deleted): fall
  // through to the real agent — normal live generation, normal progress UI.
  const app = await vendo.apps.get(entry.appId, ctx).catch(() => null)
  if (app === null) return null
  const surface = await vendo.apps.open(entry.appId, ctx).catch(() => null)
  if (surface === null || surface.kind !== "tree") return null

  const thread = await loadThread(principal, body.threadId)
  const index = thread.messages.findIndex(candidate => candidate.id === message.id)
  if (index === -1) thread.messages.push(message)
  else thread.messages[index] = message
  const payload = { name: app.name, ...surface.payload }

  const stream = createUIMessageStream<UIMessage>({
    originalMessages: thread.messages,
    execute: async ({ writer }) => {
      const write = (chunk: UIMessageChunk): void => writer.write(chunk as never)
      write({ type: "start", messageId: `msg_chip_${globalThis.crypto.randomUUID().slice(0, 12)}` })
      // The settled payload lands in one part — the app card attaches
      // instantly, exactly what "pre-generated" promises.
      write(toVendoWirePart(
        { type: "data-vendo-view", appId: entry.appId, payload },
        vendoViewStreamId(entry.appId as never),
      ) as UIMessageChunk)
      const id = `txt_${globalThis.crypto.randomUUID().slice(0, 8)}`
      write({ type: "text-start", id })
      write({ type: "text-delta", id, delta: "Already built this one — it's yours to keep or pin." })
      write({ type: "text-end", id })
    },
    onFinish: async ({ messages }) => {
      await persistThread(principal, thread.id, messages)
    },
    onError: () => "An error occurred while attaching the app.",
  })
  const response = createUIMessageStreamResponse({ stream })
  response.headers.set(THREAD_ID_HEADER, thread.id)
  return response
}
