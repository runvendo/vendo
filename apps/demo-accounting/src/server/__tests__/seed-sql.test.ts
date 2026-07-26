// Guards the Cadence auth seed's two contracts (demo-hygiene, criterion 29):
// it CONVERGES on re-apply (a drifted password/email row gets repaired — the
// old `do nothing` could never fix drift), and its literals agree with the
// src/server/users.ts canon (pinned uuids, demo password).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cadenceDemoPassword, cadenceDemoUsers } from "../users"

const seed = readFileSync(join(__dirname, "../../../supabase/seed.sql"), "utf8")

describe("supabase/seed.sql", () => {
  const savedPassword = process.env.CADENCE_DEMO_PASSWORD
  beforeEach(() => { delete process.env.CADENCE_DEMO_PASSWORD })
  afterEach(() => {
    if (savedPassword === undefined) delete process.env.CADENCE_DEMO_PASSWORD
    else process.env.CADENCE_DEMO_PASSWORD = savedPassword
  })

  it("converges: no conflict clause is a no-op", () => {
    const sql = seed.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n")
    expect(sql).not.toMatch(/do nothing/i)
    expect(seed).toMatch(/on conflict \(id\) do update set\s+encrypted_password = excluded\.encrypted_password,\s+email = excluded\.email,\s+updated_at = now\(\)/i)
    expect(seed).toMatch(/on conflict \(provider_id, provider\) do update set\s+identity_data = excluded\.identity_data,\s+updated_at = now\(\)/i)
  })

  it("hashes exactly the canon demo password", () => {
    const literals = [...seed.matchAll(/extensions\.crypt\('([^']*)'/g)].map(match => match[1])
    expect(literals).toHaveLength(2)
    for (const literal of literals) expect(literal).toBe(cadenceDemoPassword())
  })

  it("pins exactly the canon user ids and emails", () => {
    for (const user of cadenceDemoUsers()) {
      expect(seed).toContain(`'${user.subject}'`)
      expect(seed).toContain(`'${user.email}'`)
    }
  })
})
