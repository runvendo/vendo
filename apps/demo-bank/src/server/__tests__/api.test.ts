import { describe, it, expect, beforeAll } from "vitest"
import { __reseed } from "../store"
import { GET as getTxns } from "@/app/api/transactions/route"
import { GET as getTxn } from "@/app/api/transactions/[id]/route"
import { GET as getAccounts } from "@/app/api/accounts/route"

beforeAll(() => __reseed(new Date("2026-06-29T12:00:00-07:00")))

describe("api", () => {
  it("GET /api/transactions returns an enveloped page", async () => {
    const res = await getTxns(new Request("http://x/api/transactions?limit=5"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.data.length).toBe(5)
  })
  it("GET /api/transactions/:id returns the DoorDash charge", async () => {
    const res = await getTxn(new Request("http://x"), { params: Promise.resolve({ id: "txn_doordash_87" }) })
    const body = await res.json()
    expect(body.data.amount).toBe(-8700)
  })
  it("GET /api/transactions/:id 404s for missing id", async () => {
    const res = await getTxn(new Request("http://x"), { params: Promise.resolve({ id: "nope" }) })
    expect(res.status).toBe(404)
  })
  it("GET /api/accounts returns four accounts", async () => {
    const res = await getAccounts()
    const body = await res.json()
    expect(body.data.length).toBe(4)
  })
})
