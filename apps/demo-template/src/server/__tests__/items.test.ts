import { describe, it, expect, beforeEach } from "vitest"
import { __reseed } from "../store"
import { listItems, archiveItem, ItemError } from "../items"

const anchor = new Date("2026-07-16T12:00:00-07:00")

describe("items", () => {
  beforeEach(() => { __reseed(anchor) })

  it("lists the seeded items", () => {
    const items = listItems()
    expect(items.length).toBeGreaterThanOrEqual(8)
  })

  it("archives an active item and stamps updatedAt", () => {
    const active = listItems().find((i) => i.status === "active")!
    const before = active.updatedAt
    const archived = archiveItem(active.id)
    expect(archived.id).toBe(active.id)
    expect(archived.status).toBe("archived")
    expect(+new Date(archived.updatedAt)).toBeGreaterThanOrEqual(+new Date(before))
    // The mutation is visible through the read path.
    expect(listItems().find((i) => i.id === active.id)?.status).toBe("archived")
  })

  it("errors on an unknown id", () => {
    expect(() => archiveItem("item_nope")).toThrow(ItemError)
  })
})
