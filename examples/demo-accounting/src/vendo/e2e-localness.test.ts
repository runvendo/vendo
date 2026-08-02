import { describe, expect, it } from "vitest"
import { e2eSupabaseGuard, isLoopbackUrl } from "./e2e-localness"

describe("login-e2e localness guard (criterion 30)", () => {
  it("runs against a loopback stack without any opt-in", () => {
    expect(e2eSupabaseGuard("http://127.0.0.1:54321", undefined)).toEqual({ run: true })
    expect(e2eSupabaseGuard("http://localhost:54321", undefined)).toEqual({ run: true })
    expect(e2eSupabaseGuard("http://[::1]:54321", undefined)).toEqual({ run: true })
  })

  it("non-loopback URL without the explicit opt-in skips with a reason naming the guard", () => {
    const verdict = e2eSupabaseGuard("https://abcdef.supabase.co", undefined)
    expect(verdict.run).toBe(false)
    expect(verdict.reason).toContain("localness guard")
    expect(verdict.reason).toContain("https://abcdef.supabase.co")
    expect(verdict.reason).toContain("CADENCE_E2E_SUPABASE=live")
  })

  it("CADENCE_E2E_SUPABASE=live explicitly opts a non-loopback stack in", () => {
    expect(e2eSupabaseGuard("https://abcdef.supabase.co", "live")).toEqual({ run: true })
  })

  it("only the literal 'live' counts as opt-in", () => {
    expect(e2eSupabaseGuard("https://abcdef.supabase.co", "1").run).toBe(false)
    expect(e2eSupabaseGuard("https://abcdef.supabase.co", "true").run).toBe(false)
  })

  it("an unparseable URL is treated as non-local", () => {
    const verdict = e2eSupabaseGuard("not a url", undefined)
    expect(verdict.run).toBe(false)
    expect(verdict.reason).toContain("localness guard")
  })

  it("isLoopbackUrl recognises loopback hosts only", () => {
    expect(isLoopbackUrl("http://127.0.0.1:1")).toBe(true)
    expect(isLoopbackUrl("http://localhost")).toBe(true)
    expect(isLoopbackUrl("https://db.example.com")).toBe(false)
    expect(isLoopbackUrl("http://192.168.1.10:54321")).toBe(false)
  })
})
