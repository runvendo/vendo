/**
 * demo-funnel regression (demo-hygiene addendum A2): Cadence's /assistant
 * FIRST-ever load must show the scenario cards (+ chips once pre-generated) —
 * not the fire-once greeting-as-tutorial. Mirrors Maple's /vendo page test;
 * the overlay's CadenceThread passes the same discoverability="quiet".
 */
// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cadenceScenarios } from "@/vendo/scenarios"

const threadProps = vi.fn()

vi.mock("@vendoai/ui/chrome", () => ({
  ActivityPanel: () => null,
  VendoThread: (props: Record<string, unknown>) => {
    threadProps(props)
    return null
  },
}))
vi.mock("@/components/vendo/VendoRoot", () => ({
  VendoRoot: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import AssistantPage from "./page"

afterEach(() => {
  vi.unstubAllGlobals()
  threadProps.mockClear()
})

describe("/assistant full page thread", () => {
  it("first visit renders the cards, not the tutorial: quiet dial + original scenarios reference", () => {
    render(<AssistantPage />)
    expect(threadProps).toHaveBeenCalledTimes(1)
    const props = threadProps.mock.calls[0]?.[0] as Record<string, unknown>
    expect(props.discoverability).toBe("quiet")
    expect(props.suggestions).toBe(cadenceScenarios)
  })

  it("renders one chip per manifest entry below the cards", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { chips: [
        { key: "deadlines", prompt: "What filing deadlines hit next week?" },
      ] } }),
    })))
    render(<AssistantPage />)
    await waitFor(() => {
      const last = threadProps.mock.lastCall?.[0] as { suggestions: unknown[] }
      expect(last.suggestions).toEqual([...cadenceScenarios, "What filing deadlines hit next week?"])
    })
  })
})
