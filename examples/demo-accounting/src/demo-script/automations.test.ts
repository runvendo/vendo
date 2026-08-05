/**
 * The scripted-demo automations must stay REHEARSABLE. rehearse() rejects
 * anything that isn't a schedule trigger driving a `steps` run model, skips
 * `fn:` steps outright, and caps a replay at REHEARSAL_MAX_FIRINGS = 30 — so
 * a document that drifts into an agentic run, an app-function step, or a
 * sub-daily cron silently stops demoing the feature it exists to demo.
 *
 * The point of the set is the write path: a read-only automation rehearses to
 * previews only, so the mix is asserted here too.
 */
import { appDocumentSchema } from "@vendoai/core"
import { describe, expect, it } from "vitest"
import { cadenceDemoAutomations, demoAppId } from "./automations"

const SUBJECT = "8d0158a1-bf6c-4e32-9dc4-8b17c1e14a01"
const docs = () => cadenceDemoAutomations(SUBJECT)
const byKey = (key: "digest" | "review" | "chase") =>
  docs().find(d => d.id === demoAppId(key, SUBJECT))!

/** Host tool risk bands. The real risk source is .vendo/overrides.json —
 *  tools.json extracts every tool as "ungraded" — and it only grades
 *  host_setDocumentStatus (write) and host_sendClientMessage (destructive).
 *  The other three names are HAND-MAINTAINED approximations of what those
 *  demo-control tools do, with no override backing them; keep both lists in
 *  step with overrides.json when grading changes. */
const WRITE_TOOLS = ["host_setDocumentStatus", "host_simulateClientUpload", "host_createVoiceSession"]
const DESTRUCTIVE_TOOLS = ["host_sendClientMessage", "host_resetDemo"]

const stepsOf = (doc: ReturnType<typeof byKey>) => {
  const run = doc.trigger!.run
  if (run.kind !== "steps") throw new Error(`${doc.id} is not a steps automation`)
  return run.steps
}

describe("cadenceDemoAutomations", () => {
  it("builds one valid AppDocument per key, id-scoped to the subject", () => {
    const built = docs()
    expect(built).toHaveLength(3)
    for (const doc of built) {
      expect(() => appDocumentSchema.parse(doc)).not.toThrow()
      expect(doc.id).toContain(SUBJECT)
    }
    expect(new Set(built.map(d => d.id)).size).toBe(3)
  })

  it("every automation is rehearsable: schedule trigger + steps run, no fn: steps", () => {
    for (const doc of docs()) {
      expect(doc.trigger?.on.kind).toBe("schedule")
      expect(doc.trigger?.run.kind).toBe("steps")
      for (const step of stepsOf(doc)) {
        // fn: steps report "app function calls don't execute in rehearsal".
        expect(step.tool.startsWith("fn:")).toBe(false)
        expect(step.tool.startsWith("host_")).toBe(true)
      }
    }
  })

  it("uses weekly crons, so a 30-day replay stays well under the 30-firing cap", () => {
    for (const doc of docs()) {
      const on = doc.trigger!.on
      expect(on.kind).toBe("schedule")
      const cron = on.kind === "schedule" ? on.cron : undefined
      expect(cron).toBeDefined()
      // A genuinely WEEKLY cron: "m h * * dow" with a FIXED minute and hour and
      // a SINGLE pinned day-of-week, so it fires once a week (~4-5 times in a
      // 30-day replay). A pinned day-of-week alone is not enough — `0 * * * 1`
      // fires every hour on Mondays (~96 firings, over the 30-firing cap), which
      // the old `dow !== "*"` check let straight through.
      expect(cron).toMatch(/^\d{1,2} \d{1,2} \* \* [0-6]$/)
    }
  })

  it("covers the whole risk ladder — read-only, write, and destructive", () => {
    const digest = stepsOf(byKey("digest")).map(s => s.tool)
    expect(digest.some(t => [...WRITE_TOOLS, ...DESTRUCTIVE_TOOLS].includes(t))).toBe(false)

    expect(stepsOf(byKey("review")).map(s => s.tool)).toContain("host_setDocumentStatus")
    expect(stepsOf(byKey("chase")).map(s => s.tool)).toContain("host_sendClientMessage")
  })

  it("feeds each simulated action from a real read in the same firing", () => {
    for (const key of ["review", "chase"] as const) {
      const steps = stepsOf(byKey(key))
      const [read, action] = [steps[0]!, steps[1]!]
      expect([...WRITE_TOOLS, ...DESTRUCTIVE_TOOLS]).toContain(action.tool)
      // The action fans out over the read's output, so the resolved args on
      // the simulated card carry real client data rather than literals.
      expect(action.forEach).toContain(`steps.${read.id}`)
    }
  })
})
