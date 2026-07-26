// Chip tap interception: exact chip prompt + cached app ⇒ an instant-attach
// streamed turn; anything else (unknown prompt, signed-out, erased cache) ⇒
// null so the REAL agent generates with its normal progress UI.
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { UIMessage } from "ai"

const MAYA = "8d0158a1-bf6c-4e32-9dc4-8b17c1e14a01"

const state = {
  session: { subject: MAYA, display: "Maya Alvarez" } as { subject: string; display: string } | null,
  manifest: [{ key: "deadlines", prompt: "What filing deadlines hit next week?", appId: "app_gen_1" }],
  apps: new Map<string, { format: string; id: string; name: string }>([
    ["app_gen_1", { format: "vendo/app@1", id: "app_gen_1", name: "Filing deadlines" }],
  ]),
  threads: new Map<string, { id: string; data: unknown }>(),
}

vi.mock("@/server/session", () => ({
  resolveCadenceSession: async () => state.session,
}))
vi.mock("./chips", () => ({
  readChipManifest: async (subject: string) => (subject === MAYA ? state.manifest : []),
}))
vi.mock("./server", () => ({
  vendo: {
    apps: {
      get: async (appId: string) => state.apps.get(appId) ?? null,
      open: async (appId: string) =>
        state.apps.has(appId) ? { kind: "tree", payload: { nodes: [], components: {} } } : null,
    },
    store: {
      records: () => ({
        get: async (id: string) => state.threads.get(id) ?? null,
        put: async (record: { id: string; data: unknown }) => {
          state.threads.set(record.id, record)
          return record
        },
      }),
    },
  },
}))

import { chipThreadsResponse } from "./chips-response"

function threadPost(text: string): Request {
  const message: UIMessage = { id: "msg_user_1", role: "user", parts: [{ type: "text", text }] }
  return new Request("http://127.0.0.1/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  })
}

beforeEach(() => {
  state.session = { subject: MAYA, display: "Maya Alvarez" }
  state.apps.set("app_gen_1", { format: "vendo/app@1", id: "app_gen_1", name: "Filing deadlines" })
  state.threads.clear()
})

describe("chipThreadsResponse", () => {
  it("streams an instant attach for a cached chip prompt and persists the thread", async () => {
    const response = await chipThreadsResponse(threadPost("What filing deadlines hit next week?"))
    expect(response).not.toBeNull()
    const body = await response!.text()
    expect(body).toContain("data-vendo-view")
    expect(body).toContain("app_gen_1")
    expect(state.threads.size).toBe(1)
  })

  it("passes an unknown prompt through to the real agent", async () => {
    expect(await chipThreadsResponse(threadPost("Something else entirely"))).toBeNull()
  })

  it("cache miss (app erased) falls through to normal live generation", async () => {
    state.apps.delete("app_gen_1")
    expect(await chipThreadsResponse(threadPost("What filing deadlines hit next week?"))).toBeNull()
  })

  it("signed-out requests pass through untouched", async () => {
    state.session = null
    expect(await chipThreadsResponse(threadPost("What filing deadlines hit next week?"))).toBeNull()
  })
})
