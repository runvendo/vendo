// POST /api/demo/pin after the 2026-08-02 pins/placements split: the route
// writes the slot NAME into doc.placements — no fabricated base hash, no
// doc.pins write. The fake-hash synthesis (and the orphan home-hero.json
// baseline it read) is deleted.
import { beforeEach, describe, expect, it, vi } from "vitest"

const { rows, subject } = vi.hoisted(() => ({
  rows: new Map<string, { id: string; data: { subject: string; enabled: boolean; doc: Record<string, unknown> } }>(),
  subject: "maple_user",
}))

vi.mock("@/vendo/auth", () => ({ resolveMapleSession: vi.fn(async () => ({ subject })) }))
vi.mock("@/vendo/server", () => ({
  vendo: {
    store: {
      records: () => ({
        get: async (id: string) => rows.get(id) ?? null,
        list: async () => ({ records: [...rows.values()] }),
        put: async (row: { id: string; data: { subject: string; enabled: boolean; doc: Record<string, unknown> } }) => {
          rows.set(row.id, structuredClone(row))
        },
      }),
    },
  },
}))

import { POST } from "@/app/api/demo/pin/route"

const seed = (id: string, doc: Record<string, unknown> = {}) =>
  rows.set(id, { id, data: { subject, enabled: false, doc: { id, ...doc } } })

const post = (appId: string, slot = "home-hero") =>
  POST(new Request("http://maple/api/demo/pin", { method: "POST", body: JSON.stringify({ appId, slot }) }))

beforeEach(() => rows.clear())

describe("POST /api/demo/pin", () => {
  it("writes the slot into doc.placements with no base hash anywhere", async () => {
    seed("app_1")
    const res = await post("app_1")
    expect(res.status).toBe(200)
    const stored = rows.get("app_1")!.data.doc
    expect(stored.placements).toEqual(["home-hero"])
    expect(stored.pins).toBeUndefined()
    expect(JSON.stringify(stored)).not.toContain("sha256:")
    expect(JSON.stringify(stored)).not.toContain("base")
  })

  it("moves the slot between apps — latest placement wins, the old app is cleared", async () => {
    seed("app_1", { placements: ["home-hero"] })
    seed("app_2")
    await post("app_2")
    expect(rows.get("app_1")!.data.doc.placements).toEqual([])
    expect(rows.get("app_2")!.data.doc.placements).toEqual(["home-hero"])
  })

  it("re-placing the same app keeps a single entry", async () => {
    seed("app_1", { placements: ["home-hero"] })
    await post("app_1")
    expect(rows.get("app_1")!.data.doc.placements).toEqual(["home-hero"])
  })
})
