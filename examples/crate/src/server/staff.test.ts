import { describe, it, expect, beforeEach } from "vitest"
import { __reseed } from "./store"
import { findStaff, primaryStaff, staffByEmail, staffFacts } from "./staff"
import { resolveActor } from "./actor"

const ANCHOR = new Date("2026-08-07T12:00:00.000Z")

beforeEach(() => {
  __reseed(ANCHOR)
})

describe("the roster", () => {
  it("joins on email, case and whitespace insensitively", () => {
    expect(staffByEmail("yousef@crate.com")?.role).toBe("admin")
    expect(staffByEmail("  MIA@CRATE.COM ")?.role).toBe("agent")
  })

  it("treats an unknown email as not-staff rather than as an error", () => {
    expect(staffByEmail("someone@else.com")).toBeNull()
    expect(staffByEmail(undefined)).toBeNull()
    expect(staffByEmail("")).toBeNull()
  })

  it("finds a person by id, email or name, which is what someone types", () => {
    const mia = staffByEmail("mia@crate.com")!
    expect(findStaff(mia.id)?.id).toBe(mia.id)
    expect(findStaff("mia@crate.com")?.id).toBe(mia.id)
    expect(findStaff("Mia Alvarez")?.id).toBe(mia.id)
    expect(findStaff("mia")?.id).toBe(mia.id)
    expect(findStaff("nobody")).toBeNull()
  })

  it("names the owner as the default actor", () => {
    expect(primaryStaff().role).toBe("admin")
  })
})

describe("the facts the agent is told", () => {
  it("says the refund rule out loud instead of leaving it to a 403", () => {
    const owner = staffByEmail("yousef@crate.com")!
    const agent = staffByEmail("mia@crate.com")!

    expect(staffFacts(owner).canRefund).toBe("yes")
    expect(staffFacts(agent).canRefund).toMatch(/owner/)
    expect(staffFacts(owner).role).toBe("shop owner")
    expect(staffFacts(agent).role).toBe("support agent")
  })

  it("carries nothing beyond what support work needs", () => {
    const keys = Object.keys(staffFacts(primaryStaff())).sort()
    expect(keys).toEqual(["canRefund", "email", "name", "role"])
  })
})

describe("resolveActor", () => {
  it("acts as the seeded owner when Clerk is not configured", async () => {
    // The posture a fresh clone runs in: no keys, and the shop still works.
    const actor = await resolveActor(new Request("http://localhost/api/orders"))
    expect(actor?.email).toBe("yousef@crate.com")
  })

  it("honours a verified away subject", async () => {
    // The proxy sets this header only after verifying the away token, and
    // strips it from anything a caller sends.
    const req = new Request("http://localhost/api/orders", {
      headers: { "x-vendo-away-subject": "mia@crate.com" },
    })
    expect((await resolveActor(req))?.role).toBe("agent")
  })
})
