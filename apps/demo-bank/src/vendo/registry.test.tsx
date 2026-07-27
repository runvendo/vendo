/**
 * Registry-family guard: a generated app mounts these components while its
 * `$path` bindings are still resolving, so every one of them must survive a
 * render with its data prop absent. MapleSparkline and MapleSpendingDonut
 * already did; MapleNetWorthCard threw
 * "Cannot read properties of undefined (reading 'slice')" (2026-07 walkthrough,
 * caught by NodeErrorBoundary but loud in the dev overlay).
 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { mapleRegistry } from "./registry"

afterEach(cleanup)

describe("mapleRegistry components with unresolved props", () => {
  for (const [name, entry] of Object.entries(mapleRegistry)) {
    it(`${name} renders nothing instead of throwing`, () => {
      const Component = entry.component as React.ComponentType<Record<string, unknown>>
      const { container } = render(<Component />)
      expect(container.firstChild).toBeNull()
    })
  }

  it("MapleNetWorthCard still renders once its series binds", () => {
    const Component = mapleRegistry.MapleNetWorthCard.component
    const { container } = render(<Component valueCents={5_490_715} series={[5_100_000, 5_490_715]} />)
    expect(container.querySelector("[data-maple-net-worth]")).not.toBeNull()
    expect(screen.getByText("Total balance")).toBeTruthy()
  })
})
