import { describe, expect, it, vi } from "vitest"
import type { AppDocument, RecordStore, VendoRecord } from "@vendoai/core"
import { chipManifestRowId, type TryThisChip } from "./chips"
import { pregenerate } from "./chips-seed"

const MAYA = "8d0158a1-bf6c-4e32-9dc4-8b17c1e14a01"
const CHIPS: TryThisChip[] = [
  { key: "deadlines", prompt: "What filing deadlines hit next week?" },
  { key: "quiet", prompt: "Which clients have gone quiet lately?" },
]

function memoryRecords(): RecordStore {
  const rows = new Map<string, VendoRecord>()
  return {
    get: async id => rows.get(id) ?? null,
    put: async record => {
      const row = { ...record, revision: "1" } as unknown as VendoRecord
      rows.set(record.id, row)
      return row
    },
    delete: async id => { rows.delete(id) },
    list: async () => ({ records: [...rows.values()] }),
  }
}

function fakeApps(created: Map<string, AppDocument> = new Map()) {
  let counter = 0
  const create = vi.fn(async ({ prompt }: { prompt: string }) => {
    counter += 1
    const app = { format: "vendo/app@1", id: `app_gen_${counter}`, name: prompt } as AppDocument
    created.set(app.id, app)
    return app
  })
  const get = vi.fn(async (appId: string) => created.get(appId) ?? null)
  return { create, get, created }
}

describe("chip pre-generation", () => {
  it("generates every chip through the pipeline and records the manifest", async () => {
    const apps = fakeApps()
    const manifests = memoryRecords()

    const entries = await pregenerate(apps, manifests, MAYA, CHIPS)

    expect(apps.create).toHaveBeenCalledTimes(2)
    expect(entries.map(entry => entry.key)).toEqual(["deadlines", "quiet"])
    const row = await manifests.get(chipManifestRowId(MAYA))
    expect((row?.data as { entries: unknown[] }).entries).toHaveLength(2)
  })

  it("is idempotent: existing cached apps are skipped; erased ones regenerate", async () => {
    const apps = fakeApps()
    const manifests = memoryRecords()
    const first = await pregenerate(apps, manifests, MAYA, CHIPS)
    apps.create.mockClear()

    await pregenerate(apps, manifests, MAYA, CHIPS)
    expect(apps.create).not.toHaveBeenCalled()

    apps.created.delete(first[0]!.appId)
    const repaired = await pregenerate(apps, manifests, MAYA, CHIPS)
    expect(apps.create).toHaveBeenCalledTimes(1)
    expect(repaired).toHaveLength(2)
  })

  it("tolerates a failed generation: logs, skips the chip, keeps the rest", async () => {
    const apps = fakeApps()
    apps.create.mockRejectedValueOnce(new Error("model 529"))
    const manifests = memoryRecords()

    const entries = await pregenerate(apps, manifests, MAYA, CHIPS)

    expect(entries).toHaveLength(1)
    expect(entries[0]!.key).toBe("quiet")
  })
})
